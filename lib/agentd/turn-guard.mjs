/**
 * lib/agentd/turn-guard.mjs — CANH LƯỢT DÀI (#1062 G2-3): lượt > 30 phút hoặc > 1M cache-đọc ⇒ cảnh báo ĐÚNG MỘT LẦN mỗi bậc (30', 60'… / 1M, 2M…)
 * để phiên checkpoint ở điểm an toàn (commit WIP + work_state) và ghi lý do tiếp tục. Chạy như hook PostToolUse của Claude Code
 * (adapter thêm `--settings <tệp>`); cache-đọc ĐO từ tệp hội thoại (usage từng tin trợ lý, khử trùng theo message.id), đọc nối tiếp theo offset.
 * Trạng thái theo run: <dir>/<run>.json — gọi lại / phục hồi không cảnh báo lặp bậc đã báo (không lặp tác động).
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const guardDir = () => process.env.DBIO_TURN_GUARD_DIR || join(homedir(), '.dbio', 'agentd-guard');
export const DEFAULT_MINUTES = 30;
export const DEFAULT_CACHE_READ = 1_000_000;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Đọc phần MỚI của tệp hội thoại từ offset ⇒ {cache_read thêm, offset mới, ids}. Dòng cắt dở ở cuối ⇒ để lượt sau. */
export function scanTranscript(file, { offset = 0, ids = [] } = {}) {
  let fd; const seen = new Set(ids); let add = 0;
  try {
    fd = openSync(file, 'r'); const size = fstatSync(fd).size; if (size < offset) offset = 0; // tệp bị thay ⇒ đọc lại
    const len = size - offset; if (len <= 0) return { add: 0, offset, ids };
    const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, offset);
    const text = buf.toString('utf8'); const last = text.lastIndexOf('\n'); if (last < 0) return { add: 0, offset, ids };
    for (const l of text.slice(0, last).split('\n')) {
      if (!l.includes('cache_read_input_tokens')) continue;
      try { const j = JSON.parse(l); const m = j?.message; const n = Number(m?.usage?.cache_read_input_tokens); if (!Number.isFinite(n) || n <= 0) continue; const id = m?.id ?? j?.uuid; if (id && seen.has(id)) continue; if (id) seen.add(id); add += n; } catch { /* dòng hỏng */ }
    }
    return { add, offset: offset + Buffer.byteLength(text.slice(0, last + 1), 'utf8'), ids: [...seen].slice(-200) };
  } catch { return { add: 0, offset, ids }; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* bỏ */ } }
}

/** Hàm thuần: số liệu ⇒ bậc mới cần báo (null = im). */
export function evaluate({ elapsedMs, cacheRead, minutes = DEFAULT_MINUTES, cacheMax = DEFAULT_CACHE_READ, warned = { time: 0, cache: 0 } }) {
  const time = minutes > 0 ? Math.floor(elapsedMs / (minutes * 60_000)) : 0;
  const cache = cacheMax > 0 ? Math.floor(cacheRead / cacheMax) : 0;
  const hit = [];
  if (time > (warned.time ?? 0)) hit.push('time');
  if (cache > (warned.cache ?? 0)) hit.push('cache');
  return hit.length ? { hit, time: Math.max(time, warned.time ?? 0), cache: Math.max(cache, warned.cache ?? 0) } : null;
}

const fmtM = (n) => `${Math.round(n / 100_000) / 10}M`;
export function warningText({ elapsedMs, cacheRead, minutes, cacheMax, card, staff, worktree }) {
  const who = staff ? ` --as "${staff}"` : ''; const c = card ?? '<thẻ>';
  return `⏱ LƯỢT DÀI (#1062): ${Math.round(elapsedMs / 60_000)} phút · ${fmtM(cacheRead)} cache-đọc (ngưỡng ${minutes}' / ${fmtM(cacheMax)}). `
    + `Tới ĐIỂM AN TOÀN kế tiếp (test xanh / xong một bước — không phải giữa chừng sửa) thì: (1) commit WIP${worktree ? ` trong ${worktree}` : ''}: \`git add -A && git commit -m "wip(${c}): <bước>"\` `
    + `(2) \`dbio-staff staff${who} checkpoint ${c} --next "<bước kế cụ thể>"\` (hồ sơ bền: sha + work_state) `
    + `(3) tiếp tục thì ghi 1 dòng lý do: \`dbio-staff staff${who} say ${cardIdOf(c)} "⏱ tiếp tục vì …"\`; không cần tiếp thì kết thúc lượt. Cảnh báo này chỉ hiện một lần mỗi bậc.`;
}
const cardIdOf = (c) => (/^\d+#(\d+)$/.exec(String(c)) ?? [])[1] ?? c;

/**
 * Một lần hook: input = JSON stdin của Claude Code {session_id, transcript_path, …}. ⇒ {output: chuỗi JSON cho stdout | '', state}.
 * env: DBIO_RUN_ID (khoá trạng thái; vắng ⇒ session_id) · DBIO_TURN_STARTED_AT (ms) · DBIO_TURN_CARD · DBIO_TURN_STAFF · DBIO_TURN_WORKTREE · DBIO_TURN_GUARD_MIN · DBIO_TURN_GUARD_CACHE.
 */
export function guardOnce(input, { env = process.env, dir = guardDir(), now = Date.now() } = {}) {
  const key = String(env.DBIO_RUN_ID || input?.session_id || ''); if (!SAFE_ID.test(key)) return { output: '' };
  const f = join(dir, `${key}.json`);
  let st = {}; try { st = JSON.parse(readFileSync(f, 'utf8')) ?? {}; } catch { /* lần đầu */ }
  st.started_at ??= Number(env.DBIO_TURN_STARTED_AT) || now;
  st.warned ??= { time: 0, cache: 0 }; st.cache_read ??= 0;
  const tp = input?.transcript_path;
  if (tp && existsSync(tp)) { if (st.transcript !== tp) { st.transcript = tp; st.offset = 0; st.ids = []; } const s = scanTranscript(tp, { offset: st.offset ?? 0, ids: st.ids ?? [] }); st.cache_read += s.add; st.offset = s.offset; st.ids = s.ids; }
  const minutes = Number(env.DBIO_TURN_GUARD_MIN ?? DEFAULT_MINUTES); const cacheMax = Number(env.DBIO_TURN_GUARD_CACHE ?? DEFAULT_CACHE_READ);
  const elapsedMs = now - st.started_at;
  const ev = evaluate({ elapsedMs, cacheRead: st.cache_read, minutes, cacheMax, warned: st.warned });
  let output = '';
  if (ev) {
    st.warned = { time: ev.time, cache: ev.cache };
    const text = warningText({ elapsedMs, cacheRead: st.cache_read, minutes, cacheMax, card: env.DBIO_TURN_CARD || null, staff: env.DBIO_TURN_STAFF || null, worktree: env.DBIO_TURN_WORKTREE || null });
    (st.warnings ??= []).push({ at: new Date(now).toISOString(), hit: ev.hit, minutes: Math.round(elapsedMs / 60_000), cache_read: st.cache_read });
    output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
  }
  try { mkdirSync(dir, { recursive: true }); writeFileSync(`${f}.tmp`, JSON.stringify(st)); renameSync(`${f}.tmp`, f); } catch { /* sổ phụ */ }
  return { output, state: st };
}

/** Tệp --settings cho claude: hook PostToolUse gọi bin/dbio-turn-guard.mjs. Ghi một lần (nội dung cố định theo đường dẫn plugin). ⇒ đường dẫn. */
export function guardSettingsFile(dir = guardDir()) {
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'dbio-turn-guard.mjs').replace(/\\/g, '/');
  const body = JSON.stringify({ hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${bin}"`, timeout: 10 }] }] } }, null, 2);
  const f = join(dir, 'settings.json');
  try { if (!existsSync(f) || readFileSync(f, 'utf8') !== body) { mkdirSync(dir, { recursive: true }); writeFileSync(f, body); } } catch { return null; }
  return f;
}
