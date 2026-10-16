/**
 * lib/agentd/worktree.mjs — BẢO TOÀN MÃ (#1062 G2): mỗi thẻ có mã một WORKTREE riêng + merge về main TUẦN TỰ qua hàng chờ.
 * SIM-4: hai thẻ sửa cùng tệp trong MỘT cây làm việc chung ⇒ một bên mất sửa âm thầm. Ở đây mỗi thẻ một nhánh `wt/<repo>-t<id>` + thư mục `<gốc>/.wt/<repo>-t<id>`;
 * về main chỉ qua mergeCard: hàng chờ FIFO + lease `merge-<repo>` (một người gộp/lúc) ⇒ fetch → rebase lên origin/main → test tích hợp → push KHÔNG --force.
 * Xung đột / test đỏ / cây bẩn ⇒ DỪNG và báo (không tự giải, không ghi đè). Gọi lại sau khi đã gộp ⇒ already_merged (không đẩy lần hai).
 * Bẫy máy (memory feedback_worktree_*): git 2.7 (không `worktree remove`, không `stash push`) · KHÔNG npm install trong worktree (giết junction) ·
 * chỉ junction node_modules TẦNG TRÊN cho repo không phải workspace (monorepo pnpm ⇒ không link, xem feedback_worktree_cft_symlink_deploy_trap) · module này KHÔNG bao giờ xoá worktree.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createLeases, leaseDir } from './lease.mjs';
import { pidAlive } from './runs.mjs';

const CARD = /^(\d+)#(\d+)$/;
const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
export const CODE_MODES = Object.freeze(['mutate', 'transact']);

/** git đồng bộ, không ném: ⇒ {ok, out, err, code}. */
export function runGit(args, cwd) { // chỉ cắt cuối: dòng đầu `git status --porcelain` có thể bắt đầu bằng dấu cách (" M tệp")
  try { return { ok: true, out: String(execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })).trimEnd(), err: '', code: 0 }; }
  catch (e) { return { ok: false, out: String(e?.stdout ?? '').trim(), err: String(e?.stderr ?? e?.message ?? e).trim(), code: e?.status ?? -1 }; }
}

export const cardId = (card) => { const m = CARD.exec(String(card ?? '')); return m ? m[2] : null; };
export const normPath = (p) => resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** Tên khoá lease hợp lệ (^[a-z][a-z0-9_-]{0,31}$) cho repo. */
export const repoKey = (prefix, name) => `${prefix}-${String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`.slice(0, 32).replace(/-+$/, '');

/**
 * Tài nguyên MÃ của thẻ: requires.resources mode mutate|transact có id `repo:<tên>` / `repo-<tên>` / `<tên>` trỏ tới một repo git
 * (entry.repos[tên] = đường dẫn hoặc {path, test, node_modules}, hoặc $DBIO_ROOT/<tên>). store-4 … không phải repo ⇒ bỏ qua.
 */
export function codeResources(requires, { repos = {}, root = process.env.DBIO_ROOT } = {}) {
  const out = []; const seen = new Set();
  for (const r of requires?.resources ?? []) {
    if (!r || !CODE_MODES.includes(String(r.mode))) continue;
    const name = String(r.id ?? '').replace(/^repo[:-]/, '');
    if (!SAFE_REPO.test(name) || seen.has(name)) continue;
    const repo = resolveRepo(name, { repos, root }); if (!repo) continue;
    seen.add(name); out.push({ ...repo, mode: String(r.mode) });
  }
  return out;
}

export function resolveRepo(name, { repos = {}, root = process.env.DBIO_ROOT } = {}) {
  const c = repos?.[name]; const spec = typeof c === 'string' ? { path: c } : (c && typeof c === 'object' ? c : {});
  const path = spec.path ?? (root ? join(root, name) : null);
  if (!path || !existsSync(join(path, '.git'))) return null;
  return { name, path: resolve(path), test: spec.test ?? null, node_modules: spec.node_modules ?? null, base: spec.base ?? 'main' };
}

export const worktreeRoot = (repoPath) => process.env.DBIO_WORKTREE_ROOT || join(dirname(resolve(repoPath)), '.wt');
export const worktreeOf = (repo, card) => { const id = cardId(card); if (!id) return null; const slug = `${basename(repo.path)}-t${id}`; return { path: join(worktreeRoot(repo.path), slug), branch: `wt/${slug}` }; };

/** `git worktree list --porcelain` ⇒ [{path, head, branch}]. */
export function listWorktrees(repoPath, git = runGit) {
  const r = git(['worktree', 'list', '--porcelain'], repoPath); if (!r.ok) return [];
  const out = []; let cur = null;
  for (const l of r.out.split(/\r?\n/)) {
    if (l.startsWith('worktree ')) { cur = { path: l.slice(9) }; out.push(cur); }
    else if (cur && l.startsWith('HEAD ')) cur.head = l.slice(5);
    else if (cur && l.startsWith('branch ')) cur.branch = l.slice(7).replace(/^refs\/heads\//, '');
  }
  return out;
}

/** Repo kiểu workspace (pnpm/npm workspaces) ⇒ KHÔNG junction cả node_modules (bẫy đóng gói code checkout chính). */
function isWorkspaceRepo(p) {
  if (existsSync(join(p, 'pnpm-workspace.yaml'))) return true;
  try { return !!JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).workspaces; } catch { return false; }
}

/** Junction node_modules tầng trên về checkout chính (chỉ THÊM, không xoá). ⇒ 'linked' | 'exists' | 'skipped:<lý do>'. */
export function linkNodeModules(repo, wtPath) {
  const mode = repo.node_modules ?? 'auto';
  if (mode === 'none') return 'skipped:none';
  const src = join(repo.path, 'node_modules'); const dst = join(wtPath, 'node_modules');
  if (existsSync(dst)) return 'exists';
  if (!existsSync(src)) return 'skipped:no_node_modules';
  if (mode === 'auto' && isWorkspaceRepo(repo.path)) return 'skipped:workspace_repo';
  try { symlinkSync(src, dst, 'junction'); return 'linked'; } catch (e) { return `skipped:${e?.code ?? 'error'}`; }
}

/** Trạng thái BỀN của worktree (để HANDOFF tham chiếu sha/file dở thay vì lời tóm tắt). */
export function durableState(wtPath, { remote = 'origin', base = 'main', git = runGit } = {}) {
  const head = git(['rev-parse', 'HEAD'], wtPath); if (!head.ok) return null;
  const br = git(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath);
  const st = git(['status', '--porcelain'], wtPath);
  const dirty = st.ok ? st.out.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3)) : null;
  const lr = git(['rev-list', '--left-right', '--count', `${remote}/${base}...HEAD`], wtPath);
  const [behind, ahead] = lr.ok ? lr.out.split(/\s+/).map(Number) : [null, null];
  return { path: wtPath, head: head.out, branch: br.ok ? br.out : null, dirty, ahead, behind };
}

/**
 * Worktree của thẻ — IDEMPOTENT: đã có ⇒ dùng lại NGUYÊN TRẠNG (không reset, không fetch-ghi-đè, giữ commit WIP + file dở) ⇒ phục hồi sau checkpoint không lặp tác động.
 * Nhánh còn mà thư mục mất (đã prune) ⇒ gắn lại nhánh cũ. Chưa có ⇒ fetch + tạo từ origin/<base>.
 * ⇒ {ok, path, branch, created, reattached, node_modules, state} | {ok:false, detail}.
 */
export function prepareWorktree({ repo, card, remote = 'origin', git = runGit, fetch = true } = {}) {
  const wt = worktreeOf(repo, card); if (!wt) return { ok: false, detail: `thẻ không hợp lệ: ${card}` };
  const base = repo.base ?? 'main';
  const known = listWorktrees(repo.path, git).find((w) => normPath(w.path) === normPath(wt.path));
  let created = false; let reattached = false;
  if (known && existsSync(wt.path)) {
    if (known.branch && known.branch !== wt.branch) return { ok: false, detail: `worktree ${wt.path} đang ở nhánh ${known.branch}, không phải ${wt.branch} — không đụng` };
  } else {
    if (known) git(['worktree', 'prune'], repo.path); // thư mục đã mất ⇒ dọn sổ worktree (git 2.7: không có `worktree remove`)
    mkdirSync(dirname(wt.path), { recursive: true });
    if (existsSync(wt.path) && readdirSync(wt.path).length) return { ok: false, detail: `${wt.path} đã có nội dung mà không phải worktree của ${repo.name} — không ghi đè` };
    const hasBranch = git(['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`], repo.path).ok;
    if (hasBranch) { const r = git(['worktree', 'add', wt.path, wt.branch], repo.path); if (!r.ok) return { ok: false, detail: `git worktree add: ${r.err.slice(0, 200)}` }; reattached = true; }
    else {
      if (fetch) git(['fetch', '--quiet', remote], repo.path);
      const r = git(['worktree', 'add', '-b', wt.branch, wt.path, `${remote}/${base}`], repo.path);
      if (!r.ok) return { ok: false, detail: `git worktree add -b: ${r.err.slice(0, 200)}` };
      created = true;
    }
  }
  const nm = linkNodeModules(repo, wt.path);
  return { ok: true, path: wt.path, branch: wt.branch, created, reattached, node_modules: nm, state: durableState(wt.path, { remote, base, git }) };
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }); // KHÔNG unref: CLI `merge` đang chờ hàng phải giữ tiến trình sống

/** Hàng chờ FIFO theo repo: vé = tệp `<ms>-<pid>-<ngẫu nhiên>.json`; tới lượt = vé sống cũ nhất. Vé của tiến trình đã chết / quá hạn ⇒ bỏ qua. */
export function createMergeQueue({ dir = join(leaseDir(), 'merge-queue'), now = () => Date.now(), staleMs = 3_600_000 } = {}) {
  const qdir = (key) => join(dir, key);
  const live = (key) => {
    let fs_ = []; try { fs_ = readdirSync(qdir(key)).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
    return fs_.filter((f) => { try { const j = JSON.parse(readFileSync(join(qdir(key), f), 'utf8')); if (now() - Number(j.at) > staleMs || !pidAlive(Number(j.pid))) { try { unlinkSync(join(qdir(key), f)); } catch { /* bỏ */ } return false; } return true; } catch { return false; } });
  };
  return {
    enqueue(key, info = {}) { mkdirSync(qdir(key), { recursive: true }); const t = now(); const f = `${String(t).padStart(15, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`; writeFileSync(join(qdir(key), f), JSON.stringify({ ...info, pid: process.pid, at: t })); return f; },
    position(key, ticket) { const l = live(key); const i = l.indexOf(ticket); return i < 0 ? -1 : i; },
    leave(key, ticket) { try { unlinkSync(join(qdir(key), ticket)); } catch { /* bỏ */ } },
    waiting: (key) => live(key).length,
  };
}

/** Lệnh test tích hợp: repo.test (chuỗi ⇒ qua shell; mảng ⇒ chạy thẳng) · mặc định `npm test` nếu package.json có scripts.test · false ⇒ bỏ. */
export function defaultTest(repo, wtPath) {
  if (repo.test === false) return null;
  if (repo.test) return repo.test;
  try { return JSON.parse(readFileSync(join(wtPath, 'package.json'), 'utf8'))?.scripts?.test ? 'npm test' : null; } catch { return null; }
}
export function runTest(cmd, cwd, timeoutS = 1200) {
  const r = Array.isArray(cmd) ? spawnSync(String(cmd[0]), cmd.slice(1).map(String), { cwd, encoding: 'utf8', timeout: timeoutS * 1000, windowsHide: true })
    : spawnSync(String(cmd), { cwd, encoding: 'utf8', timeout: timeoutS * 1000, shell: true, windowsHide: true });
  return { ok: r.status === 0, code: r.status, tail: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(-1500) };
}

const conflictFiles = (wtPath, git) => { const r = git(['diff', '--name-only', '--diff-filter=U'], wtPath); return r.ok ? r.out.split(/\r?\n/).filter(Boolean) : []; };

/**
 * GỘP thẻ về main, TUẦN TỰ. ⇒ {ok, status, …} — status: merged | already_merged | dirty | conflict | test_failed | push_failed | queue_timeout | error.
 * Chỉ `merged` đẩy lên remote; mọi nhánh lỗi để nguyên worktree/nhánh thẻ (không mất gì) và nêu tệp/lý do cụ thể.
 */
export async function mergeCard({ repo, card, wtPath = worktreeOf(repo, card)?.path, remote = 'origin', strategy = 'rebase', test, holder = `merge:${card}`, git = runGit, testRunner = runTest, leases = createLeases(), queue = createMergeQueue(), waitMs = 1_800_000, pollMs = 200, maxPush = 3 } = {}) {
  if (!wtPath || !existsSync(wtPath)) return { ok: false, status: 'error', detail: `không thấy worktree của ${card}` };
  const base = repo.base ?? 'main';
  const dirty = durableState(wtPath, { remote, base, git })?.dirty ?? [];
  if (dirty.length) return { ok: false, status: 'dirty', files: dirty, detail: `${dirty.length} file chưa commit — commit (hoặc bỏ có chủ ý) rồi gộp lại` };
  const key = repoKey('merge', repo.name);
  const ticket = queue.enqueue(key, { card, holder }); const t0 = Date.now();
  let gen = null;
  try {
    for (;;) { // tới lượt (vé cũ nhất) VÀ giữ được lease merge-<repo>
      if (queue.position(key, ticket) === 0) { const a = leases.acquire(key, { holder, pid: process.pid, ttl_s: Math.ceil(waitMs / 1000) + 600 }); if (a.ok) { gen = a.gen; break; } }
      if (Date.now() - t0 > waitMs) return { ok: false, status: 'queue_timeout', detail: `chờ hàng gộp ${repo.name} quá ${Math.round(waitMs / 60000)}'` };
      await sleep(pollMs);
    }
    for (let attempt = 1; ; attempt++) {
      const f = git(['fetch', '--quiet', remote], wtPath); if (!f.ok) return { ok: false, status: 'error', detail: `git fetch: ${f.err.slice(0, 200)}` };
      const target = `${remote}/${base}`;
      const before = git(['rev-parse', target], wtPath).out;
      if (git(['merge-base', '--is-ancestor', 'HEAD', target], wtPath).ok) return { ok: true, status: 'already_merged', sha: git(['rev-parse', 'HEAD'], wtPath).out, remote_head: before };
      const r = strategy === 'merge' ? git(['merge', '--no-edit', target], wtPath) : git(['rebase', target], wtPath);
      if (!r.ok) {
        const files = conflictFiles(wtPath, git);
        git([strategy === 'merge' ? 'merge' : 'rebase', '--abort'], wtPath);
        return { ok: false, status: 'conflict', files, detail: `xung đột khi ${strategy} lên ${target}${files.length ? `: ${files.join(', ')}` : ''} — nhánh thẻ giữ nguyên, sửa xung đột trong worktree rồi gộp lại` };
      }
      const cmd = test === undefined ? defaultTest(repo, wtPath) : test;
      if (cmd) { const tr = testRunner(cmd, wtPath); if (!tr.ok) return { ok: false, status: 'test_failed', detail: `test tích hợp đỏ (${typeof cmd === 'string' ? cmd : cmd.join(' ')}, mã ${tr.code})`, tail: tr.tail }; }
      const p = git(['push', remote, `HEAD:refs/heads/${base}`], wtPath); // KHÔNG --force: remote đổi giữa chừng ⇒ bị từ chối ⇒ vòng lại
      if (p.ok) return { ok: true, status: 'merged', sha: git(['rev-parse', 'HEAD'], wtPath).out, before, attempts: attempt, tested: !!cmd };
      if (attempt >= maxPush) return { ok: false, status: 'push_failed', detail: `push bị từ chối ${attempt} lần: ${p.err.slice(0, 200)}` };
    }
  } finally {
    if (gen != null) leases.release(key, { holder, gen });
    queue.leave(key, ticket);
  }
}

/** Dòng phiếu bàn giao: tham chiếu trạng thái BỀN (sha thật, file dở thật) đọc từ git lúc giao việc. */
export function handoffLines(card, wts) {
  const out = [];
  for (const w of wts) {
    const s = w.state ?? {};
    out.push(`worktree thẻ (${w.repo}): ${w.path} · nhánh ${w.branch} · HEAD ${String(s.head ?? '?').slice(0, 7)} · ${s.dirty?.length ? `${s.dirty.length} file dở (${s.dirty.slice(0, 5).join(', ')})` : 'sạch'} · +${s.ahead ?? '?'}/-${s.behind ?? '?'} so với origin/main · ${w.created ? 'MỚI tạo' : w.reattached ? 'gắn lại nhánh cũ' : 'dùng lại nguyên trạng'}`);
  }
  if (wts.length) out.push(`⇒ Sửa mã CHỈ trong worktree trên (không sửa checkout chính). Đối chiếu HEAD với hồ sơ trước khi sửa. Gộp về main: commit rồi \`dbio-agentd merge ${card} --repo ${wts.map((w) => w.repo).join(',')}\` (hàng chờ tuần tự · rebase · test · push không --force; xung đột/test đỏ ⇒ lệnh báo, KHÔNG tự ghi đè).`);
  return out;
}

