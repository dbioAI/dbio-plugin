// #1062 G2 — bảo toàn mã: worktree theo thẻ + gộp tuần tự + lease repo + canh lượt dài. Repo git THẬT trong thư mục tạm (origin trần + bản chính).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLeases } from '../lib/agentd/lease.mjs';
import { codeResources, createMergeQueue, mergeCard, prepareWorktree, resolveRepo, worktreeOf } from '../lib/agentd/worktree.mjs';
import { evaluate, guardOnce, scanTranscript } from '../lib/agentd/turn-guard.mjs';
import { withWorkspace } from '../lib/agentd/workspace.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dbio-agentd.mjs');
const ROOT = mkdtempSync(join(tmpdir(), 'agentd-wt-'));
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', DBIO_WORKTREE_ROOT: join(ROOT, '.wt'), DBIO_AGENTD_LEASE_DIR: join(ROOT, 'leases'), DBIO_TURN_GUARD_DIR: join(ROOT, 'guard') });
const g = (cwd, ...a) => String(execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
const LINES = 20;

/** origin trần + bản chính `<ROOT>/<name>` có shared.txt 20 dòng. */
function makeRepo(name) {
  const bare = join(ROOT, `${name}.git`); const main = join(ROOT, name);
  g(ROOT, 'init', '--bare', '-q', bare); g(ROOT, 'clone', '-q', bare, main);
  writeFileSync(join(main, 'shared.txt'), Array.from({ length: LINES }, (_, i) => `dòng ${i + 1}`).join('\n') + '\n');
  g(main, 'add', '-A'); g(main, 'commit', '-qm', 'init'); g(main, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  g(main, 'fetch', '-q', 'origin');
  return resolveRepo(name, { root: ROOT });
}
const originFile = (repo) => { g(repo.path, 'fetch', '-q', 'origin'); return g(repo.path, 'show', 'origin/main:shared.txt'); };
function editLine(wt, line, text) { const f = join(wt, 'shared.txt'); const ls = readFileSync(f, 'utf8').split('\n'); ls[line - 1] = text; writeFileSync(f, ls.join('\n')); }
function mergeProc(card, repoName) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [BIN, 'merge', card, '--repo', repoName, '--json'], { env: { ...process.env, DBIO_ROOT: ROOT }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (b) => { out += b; }); c.stderr.on('data', (b) => { out += b; });
    c.on('close', (code) => { let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* lỗi */ } res({ code, j, out }); });
  });
}

test('#1062 ĐẠT-1: 10 cặp (T1062_FULL=1; mặc định 2) thẻ sửa CÙNG tệp, gộp ĐỒNG THỜI (2 tiến trình) ⇒ 0 mất sửa âm thầm', { timeout: 1_200_000 }, async () => {
  const repo = makeRepo('proj');
  let silent = 0; let merged = 0; let conflicts = 0;
  const PAIRS = process.env.T1062_FULL ? 10 : 2; // ĐẠT đầy đủ: T1062_FULL=1 (git 2.7 Windows chậm ~40s/cặp)
  for (let i = 0; i < PAIRS; i++) {
    const A = `9#${100 + 2 * i}`; const B = `9#${101 + 2 * i}`;
    const wa = prepareWorktree({ repo, card: A }); const wb = prepareWorktree({ repo, card: B });
    assert.ok(wa.ok && wb.ok && wa.created && wb.created);
    const same = i % 2 === 1; // cặp lẻ: CÙNG dòng (xung đột thật) · cặp chẵn: khác dòng cùng tệp
    const ma = `A${i}-${A}`; const mb = `B${i}-${B}`;
    editLine(wa.path, 1 + (i % 5), ma); editLine(wb.path, same ? 1 + (i % 5) : LINES - (i % 5), mb);
    g(wa.path, 'commit', '-qam', `sửa ${A}`); g(wb.path, 'commit', '-qam', `sửa ${B}`);
    const [ra, rb] = await Promise.all([mergeProc(A, 'proj'), mergeProc(B, 'proj')]);
    const main = originFile(repo);
    for (const [r, mark, wt] of [[ra, ma, wa.path], [rb, mb, wb.path]]) {
      const inMain = main.includes(mark);
      assert.ok(r.j, `không đọc được kết quả merge: ${r.out}`);
      if (r.j.status === 'merged' || r.j.status === 'already_merged') { merged++; if (!inMain) silent++; }
      else { assert.equal(r.j.status, 'conflict', r.out); assert.equal(r.code, 3); conflicts++; assert.ok(readFileSync(join(wt, 'shared.txt'), 'utf8').includes(mark), 'nhánh thẻ bị xung đột phải còn nguyên sửa của nó'); assert.ok(!existsSync(join(wt, '.git', 'rebase-apply'))); }
      if (inMain) assert.ok(['merged', 'already_merged'].includes(r.j.status));
    }
    if (!same) assert.ok(main.includes(ma) && main.includes(mb), `cặp ${i} khác dòng: cả hai phải vào main`);
    else assert.ok(main.includes(ma) !== main.includes(mb), `cặp ${i} cùng dòng: đúng MỘT bên vào, bên kia báo xung đột`);
  }
  assert.equal(silent, 0, 'mất sửa âm thầm');
  assert.equal(merged, PAIRS * 1.5); assert.equal(conflicts, PAIRS / 2);
  assert.equal(originFile(repo).split('\n').filter(Boolean).length, LINES, 'tệp không hỏng/nhân dòng');
});

test('#1062 ĐẠT-2: 10 lần checkpoint/phục hồi ⇒ worktree dùng lại NGUYÊN TRẠNG, cảnh báo không lặp, gộp không đẩy 2 lần', { timeout: 120_000 }, async () => {
  const repo = makeRepo('proj2'); const card = '9#500';
  const leases = createLeases({ dir: join(ROOT, 'leases2') }); const queue = createMergeQueue({ dir: join(ROOT, 'q2') });
  let lastHead = null; let lastDirty = null; const paths = new Set();
  const tr = join(ROOT, 'transcript-500.jsonl'); writeFileSync(tr, '');
  const env = { DBIO_RUN_ID: 'run-500', DBIO_TURN_STARTED_AT: '0', DBIO_TURN_CARD: card, DBIO_TURN_STAFF: 'Qa' };
  let warnings = 0;
  for (let k = 0; k < 10; k++) {
    const w = prepareWorktree({ repo, card }); assert.ok(w.ok, w.detail); paths.add(w.path);
    assert.equal(w.created, k === 0, 'chỉ tạo lần đầu');
    if (lastHead) { assert.equal(w.state.head, lastHead, 'phục hồi KHÔNG reset HEAD'); assert.deepEqual(w.state.dirty, lastDirty, 'phục hồi giữ file dở'); }
    // lượt k: sửa → commit WIP (điểm an toàn) → để lại 1 file dở → "chết"
    appendFileSync(join(w.path, 'shared.txt'), `wip ${k}\n`); g(w.path, 'add', '-A'); g(w.path, 'commit', '-qm', `wip(${card}): bước ${k}`);
    writeFileSync(join(w.path, 'note.txt'), `dở ${k}\n`);
    const st = prepareWorktree({ repo, card }).state; lastHead = st.head; lastDirty = st.dirty;
    // canh lượt: mỗi lượt +10 phút, +400k cache-đọc (2 dòng cùng message.id ⇒ tính 1)
    const line = JSON.stringify({ type: 'assistant', message: { id: `m${k}`, usage: { cache_read_input_tokens: 400_000 } } });
    appendFileSync(tr, `${line}\n${line}\n`);
    const r = guardOnce({ session_id: 's', transcript_path: tr }, { env, now: (k + 1) * 10 * 60_000 });
    if (r.output) { warnings++; assert.match(JSON.parse(r.output).hookSpecificOutput.additionalContext, /checkpoint 9#500/); }
    assert.equal(guardOnce({ session_id: 's', transcript_path: tr }, { env, now: (k + 1) * 10 * 60_000 }).output, '', 'gọi lại cùng thời điểm ⇒ im (không lặp)');
  }
  assert.equal(paths.size, 1);
  // 100 phút ⇒ bậc thời gian 1..3; 4M cache-đọc ⇒ bậc 1..4; các bậc trùng lần gọi gộp một cảnh báo
  const st = JSON.parse(readFileSync(join(ROOT, 'guard', 'run-500.json'), 'utf8'));
  assert.equal(st.cache_read, 4_000_000); assert.deepEqual(st.warned, { time: 3, cache: 4 }); assert.equal(st.warnings.length, warnings); assert.ok(warnings >= 4 && warnings <= 7);
  // gộp: cây bẩn ⇒ từ chối; sạch ⇒ merged; gọi lại ⇒ already_merged, origin không đổi
  const wt = worktreeOf(repo, card).path;
  const d = await mergeCard({ repo, card, leases, queue, test: null }); assert.equal(d.status, 'dirty'); assert.deepEqual(d.files, ['note.txt']);
  g(wt, 'add', '-A'); g(wt, 'commit', '-qm', 'xong');
  const m1 = await mergeCard({ repo, card, leases, queue, test: null }); assert.equal(m1.status, 'merged', m1.detail);
  const head1 = g(repo.path, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0];
  for (let k = 0; k < 3; k++) { const m = await mergeCard({ repo, card, leases, queue, test: null }); assert.equal(m.status, 'already_merged'); }
  assert.equal(g(repo.path, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], head1, 'không đẩy lần hai');
  assert.equal(originFile(repo).split('\n').filter((l) => l.startsWith('wip ')).length, 10, 'mỗi bước WIP đúng một lần');
  assert.equal(leases.status('merge-proj2')?.held ?? false, false, 'lease gộp đã nhả');
});

test('#1062 test tích hợp đỏ ⇒ KHÔNG push, nhánh thẻ giữ nguyên', { timeout: 60_000 }, async () => {
  const repo = makeRepo('proj3'); const card = '9#600';
  const w = prepareWorktree({ repo, card }); editLine(w.path, 3, 'x'); g(w.path, 'commit', '-qam', 'x');
  const before = g(repo.path, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0];
  const r = await mergeCard({ repo, card, test: 'x', testRunner: () => ({ ok: false, code: 1, tail: 'FAIL' }), leases: createLeases({ dir: join(ROOT, 'l3') }), queue: createMergeQueue({ dir: join(ROOT, 'q3') }) });
  assert.equal(r.status, 'test_failed'); assert.equal(r.tail, 'FAIL');
  assert.equal(g(repo.path, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], before);
});

test('#1062 codeResources: chỉ repo git + mode mutate/transact; store-4 / read bỏ qua', () => {
  makeRepo('proj4');
  const rs = codeResources({ resources: [{ id: 'repo:proj4', mode: 'mutate' }, { id: 'proj4', mode: 'mutate' }, { id: 'store-4', mode: 'mutate' }, { id: 'proj4', mode: 'read' }, { id: '../x', mode: 'mutate' }] }, { root: ROOT });
  assert.deepEqual(rs.map((r) => [r.name, r.mode]), [['proj4', 'mutate']]);
  assert.deepEqual(codeResources(null, { root: ROOT }), []);
});

test('#1062 withWorkspace: cwd = worktree thẻ, phiếu có sha bền, --settings canh lượt, lease 1 lượt mutate/repo, nhả khi xong', async () => {
  makeRepo('proj5');
  const leases = createLeases({ dir: join(ROOT, 'l5') }); const seen = [];
  let finish; const inner = { name: 'claude-cli', async wake(ctx) { seen.push(ctx); return { ok: true, pid: process.pid, detail: 'đã chạy', running: new Promise((r) => { finish = r; }) }; } };
  const ad = withWorkspace(inner, { leases, root: ROOT, guardSettings: () => 'G:/settings.json' });
  const handoff = { text: 'Thẻ 9#700', tokens: 3, card: '9#700', requires: { resources: [{ id: 'repo:proj5', mode: 'mutate' }] } };
  const ctx = (staff, card) => ({ staff, entry: { adapter: 'claude-cli', cwd: ROOT, session: 's' }, prompt: 'p', events: [{ task: card }], handoff: { ...handoff, card }, prevCard: card, runEnv: { DBIO_RUN_ID: `r-${staff}` }, timeoutS: 60 });
  const r = await ad.wake(ctx('NV1', '9#700'));
  assert.ok(r.ok); const c = seen[0];
  assert.equal(c.entry.cwd, worktreeOf(resolveRepo('proj5', { root: ROOT }), '9#700').path);
  assert.match(c.handoff.text, /worktree thẻ \(proj5\): .* HEAD [0-9a-f]{7} · sạch/);
  assert.deepEqual(c.entry.args.slice(-2), ['--settings', 'G:/settings.json']);
  assert.equal(c.prevCard, null); assert.equal(c.runEnv.DBIO_TURN_CARD, '9#700'); assert.equal(c.runEnv.DBIO_RUN_ID, 'r-NV1');
  assert.equal(leases.status('repo-proj5').holder, 'NV1');
  const r2 = await ad.wake(ctx('Qa', '9#701'));
  assert.equal(r2.ok, false); assert.equal(r2.hold, true); assert.match(r2.detail, /proj5 đang có lượt mutate của NV1/); assert.equal(seen.length, 1, 'bận ⇒ KHÔNG spawn');
  finish({ code: 0 }); await r.running;
  assert.equal(leases.status('repo-proj5').held, false, 'tiến trình xong ⇒ nhả lease');
  const r3 = await ad.wake(ctx('Qa', '9#701')); assert.ok(r3.ok); finish({ code: 0 }); await r3.running;
  // thẻ không khai repo ⇒ adapter gốc, không worktree, không lease (chỉ canh lượt)
  const r4 = await ad.wake({ ...ctx('NV2', '9#702'), handoff: { text: 't', tokens: 1, card: '9#702', requires: null } }); finish({ code: 0 }); await r4.running;
  assert.equal(seen.at(-1).entry.cwd, ROOT); assert.equal(seen.at(-1).prevCard, '9#702');
  // adapter trả lỗi ⇒ lease nhả ngay
  const bad = withWorkspace({ name: 'claude-cli', async wake() { return { ok: false, detail: 'x' } } }, { leases, root: ROOT, guardSettings: () => null });
  assert.equal((await bad.wake(ctx('NV3', '9#703'))).ok, false); assert.equal(leases.status('repo-proj5').held, false);
  // tắt bằng entry.workspace=false
  const off = await ad.wake({ ...ctx('NV4', '9#704'), entry: { adapter: 'claude-cli', cwd: ROOT, session: 's', workspace: false } }); finish({ code: 0 }); await off.running;
  assert.equal(seen.at(-1).entry.cwd, ROOT); assert.equal(seen.at(-1).entry.args, undefined);
});

test('#1062 turn-guard: khử trùng message.id, đọc nối tiếp, bậc báo một lần', () => {
  const f = join(ROOT, 'tg.jsonl'); mkdirSync(ROOT, { recursive: true });
  const L = (id, n) => JSON.stringify({ message: { id, usage: { cache_read_input_tokens: n } } });
  writeFileSync(f, `${L('a', 100)}\n${L('a', 100)}\n${L('b', 50)}\n{"cắt dở`);
  const s1 = scanTranscript(f); assert.equal(s1.add, 150);
  appendFileSync(f, `"}\n${L('b', 50)}\n${L('c', 7)}\n`);
  const s2 = scanTranscript(f, s1); assert.equal(s2.add, 7);
  assert.equal(evaluate({ elapsedMs: 29 * 60_000, cacheRead: 999_999 }), null);
  assert.deepEqual(evaluate({ elapsedMs: 31 * 60_000, cacheRead: 0 }), { hit: ['time'], time: 1, cache: 0 });
  assert.equal(evaluate({ elapsedMs: 59 * 60_000, cacheRead: 0, warned: { time: 1, cache: 0 } }), null);
  assert.deepEqual(evaluate({ elapsedMs: 0, cacheRead: 2_100_000, warned: { time: 0, cache: 1 } }).hit, ['cache']);
});
