/**
 * lib/evidence.mjs — #1089: collector chứng cứ cổng G3 (#1063, docs §87). Nhân viên KHÔNG gõ tay: checkpoint / done / agentd tự thu
 * repo@sha · scope_diff · bản ghi chạy kiểm · deploy rồi gửi `task_board evidence_add` bằng KHOÁ MÁY (khoá nhân viên bị từ chối ghi các kind này).
 * Phần THUẦN (planEvidence, weakeningLines, presetOf…) tách khỏi IO (git, tệp, mạng) để test cách ly.
 * Mọi lỗi collector chỉ là cảnh báo — không bao giờ chặn checkpoint / done (cổng phía máy chủ mới là nơi chặn).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const evidenceDir = () => process.env.DBIO_EVIDENCE_DIR || join(homedir(), '.dbio', 'evidence');
const key = (board, card) => `${Number(board)}-${Number(card)}`;
export const recordsFile = (board, card) => join(evidenceDir(), `${key(board, card)}.records.jsonl`);
export const sentFile = (board, card) => join(evidenceDir(), `${key(board, card)}.sent.json`);

/** Dòng `+` thêm vào làm yếu bộ test (khớp testDisableFlags phía máy chủ): .skip · xit/xdescribe · .only · passWithNoTests. */
const WEAKEN_RE = /\.skip\b|\bxit\(|\bxdescribe\(|\.only\(|passWithNoTests|\bit\.todo\(/;
export const weakeningLines = (diffText) => String(diffText ?? '').split('\n')
  .filter((l) => l.startsWith('+') && !l.startsWith('+++') && WEAKEN_RE.test(l)).map((l) => l.slice(1).trim().slice(0, 200)).slice(0, 20);

const g = (dir, ...a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }).trimEnd(); } catch { return ''; } };
const gOk = (dir, ...a) => { try { execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' }); return true; } catch { return false; } };
const lines = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);

/**
 * Sự thật git của một worktree cho collector. base = merge-base(HEAD, origin/main) (đã `fetch` ở nơi gọi nếu cần).
 * ⇒ {head, base, branch, on_main, pushed, files[], deleted[], added_lines[]} | null (không ở trong repo / không có HEAD).
 */
export function collectGit(dir, run = g, ok = gOk) {
  const top = run(dir, 'rev-parse', '--show-toplevel'); if (!top) return null;
  const head = run(top, 'rev-parse', 'HEAD'); if (!/^[0-9a-f]{40}$/i.test(head)) return null;
  const base = run(top, 'merge-base', 'HEAD', 'origin/main') || '';
  // on_main: HEAD là tổ tiên của origin/main (đã merge). Không có origin/main ⇒ false.
  const onMain = ok(top, 'merge-base', '--is-ancestor', head, 'origin/main');
  const range = base && base !== head ? `${base}..${head}` : null;
  const files = range ? lines(run(top, 'diff', '--name-only', range)) : [];
  const deleted = range ? lines(run(top, 'diff', '--name-only', '--diff-filter=D', range)) : [];
  const added = range ? weakeningLines(run(top, 'diff', '-U0', range)) : [];
  return { top, head, base, branch: run(top, 'rev-parse', '--abbrev-ref', 'HEAD'), on_main: onMain, pushed: !!run(top, 'branch', '-r', '--contains', head), files, deleted, added_lines: added };
}

/** Bản ghi chạy kiểm cục bộ (do `staff run` ghi): {preset, cmd, exit, sha, at, run_id}. Đọc tất cả, bỏ dòng hỏng. */
export function readRecords(board, card) {
  const f = recordsFile(board, card); if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && typeof r.preset === 'string' && Number.isInteger(r.exit));
}
export function appendRecord(board, card, rec) {
  mkdirSync(evidenceDir(), { recursive: true });
  appendFileSync(recordsFile(board, card), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
}
/** Đoán preset từ lệnh khi người chạy không khai: build:dash · build · unit (test) — không khớp ⇒ null (bắt buộc --preset). */
export function presetOf(cmd) {
  const s = String(cmd ?? '');
  if (/build:dash/.test(s)) return 'build:dash';
  if (/\b(test|vitest|jest|node\s+--test)\b/.test(s)) return 'unit';
  if (/\bbuild\b|\btsc\b/.test(s)) return 'build';
  return null;
}

export function readSent(board, card) { try { return JSON.parse(readFileSync(sentFile(board, card), 'utf8')); } catch { return { keys: [] }; } }
export function writeSent(board, card, st) { try { mkdirSync(evidenceDir(), { recursive: true }); writeFileSync(sentFile(board, card), JSON.stringify(st)); } catch { /* thư mục chỉ-đọc ⇒ lần sau gửi lại, máy chủ chịu được dòng thừa */ } }

/**
 * KẾ HOẠCH gửi (thuần). Thứ tự quan trọng: máy chủ đòi record có id SAU repo_sha cuối ⇒ repo_sha → scope_diff → record → deploy.
 *  facts   = collectGit(); records = readRecords(); sent = Set các khoá đã gửi; deploy = {version, sha?} | null; attemptBase = sha | null (chỉ gửi 1 lần/attempt)
 *  Mỗi bước có `k` (khoá chống gửi lại). Bản ghi chỉ tính khi sha của nó = HEAD hiện tại (chạy trên mã cũ ⇒ không đưa lên).
 */
export function planEvidence({ facts, records = [], sent = new Set(), deploy = null, attemptBase = null, author = null, runId = null }) {
  const out = []; if (!facts) return out;
  const sh = facts.head;
  if (attemptBase && !sent.has(`base:${attemptBase}`)) out.push({ k: `base:${attemptBase}`, args: { kind: 'attempt_base', sha: attemptBase, ...(author ? { payload: { author } } : {}) } });
  const shaK = `sha:${sh}:${facts.on_main ? 'main' : 'br'}`;
  if (!sent.has(shaK)) out.push({ k: shaK, args: { kind: 'repo_sha', sha: sh, payload: { on_main: !!facts.on_main, branch: facts.branch } } });
  const diffK = `diff:${sh}:${facts.files.length}:${facts.deleted.length}:${facts.added_lines.length}`;
  if (!sent.has(diffK)) out.push({ k: diffK, args: { kind: 'scope_diff', sha: sh, files: facts.files, deleted: facts.deleted, added_lines: facts.added_lines } });
  // bản ghi MỚI NHẤT mỗi preset, gắn đúng HEAD
  const latest = new Map(); for (const r of records) if (r.sha && String(sh).startsWith(String(r.sha).slice(0, 7)) && String(r.sha).length >= 7) latest.set(r.preset, r);
  for (const r of latest.values()) {
    const rk = `rec:${sh}:${r.preset}:${r.exit}:${r.at ?? ''}`;
    if (!sent.has(rk)) out.push({ k: rk, args: { kind: 'record', sha: sh, payload: { preset: r.preset, exit: r.exit, run_id: r.run_id ?? runId ?? null, ...(r.cmd ? { cmd: String(r.cmd).slice(0, 200) } : {}) } } });
  }
  if (deploy?.version) {
    const dk = `dep:${deploy.sha ?? sh}:${deploy.version}`;
    if (!sent.has(dk)) out.push({ k: dk, args: { kind: 'deploy', sha: deploy.sha ?? sh, payload: { source: 'cli_live', version: String(deploy.version), sha: deploy.sha ?? sh } } });
  }
  return out;
}

/**
 * THU + GỬI. call(args) ⇒ gọi `task_board evidence_add` bằng khoá máy (ném khi lỗi). Không có khoá máy ⇒ {skipped:'no_machine_key'}.
 * ⇒ {sent:[kind…], failed:[{kind,error}], skipped?, head}. Chỉ đánh dấu đã-gửi khi máy chủ nhận.
 */
export async function collectAndSend({ board, card, dir, call, facts = undefined, deploy = null, attemptBase = null, author = null, runId = null }) {
  if (typeof call !== 'function') return { sent: [], failed: [], skipped: 'no_machine_key' };
  const f = facts === undefined ? collectGit(dir) : facts;
  if (!f) return { sent: [], failed: [], skipped: 'no_git' };
  const st = readSent(board, card); const sent = new Set(st.keys ?? []);
  const plan = planEvidence({ facts: f, records: readRecords(board, card), sent, deploy, attemptBase, author, runId });
  const res = { sent: [], failed: [], head: f.head };
  for (const step of plan) {
    try { await call({ profile_id: Number(board), task_id: Number(card), ...step.args }); sent.add(step.k); res.sent.push(step.args.kind); }
    catch (e) { res.failed.push({ kind: step.args.kind, error: String(e?.message ?? e).slice(0, 200) }); if (e?.auth) break; /* khoá hỏng ⇒ dừng, không gửi tiếp */ }
  }
  writeSent(board, card, { keys: [...sent].slice(-200) });
  return res;
}

/** Một dòng cho checkpoint / done. */
export function summarize(r) {
  if (!r) return '';
  if (r.skipped === 'no_machine_key') return ' · chứng cứ: bỏ qua (chưa có khoá máy ~/.dbio/machine.key)';
  if (r.skipped) return ` · chứng cứ: bỏ qua (${r.skipped})`;
  return ` · chứng cứ ${r.sent.length ? r.sent.join('+') + ' ✓' : 'đã đủ (không có gì mới)'}${r.failed.length ? ` · ⚠ lỗi ${r.failed.map((x) => `${x.kind}: ${x.error}`).join('; ')}` : ''}`;
}

/** Chế độ cổng (cấu hình phòng, #1089 mục 3): thuần — dùng để agentd/CLI báo; máy chủ giữ nguồn chuẩn `evidence_gate.mode`. */
export const GATE_MODES = ['off', 'warn', 'block'];
