/**
 * lib/agentd/context-size.mjs — ước lượng NGỮ CẢNH hiện tại của một phiên Claude Code (token) từ tệp hội thoại ~/.claude/projects/<dự án>/<cliSessionId>.jsonl:
 * lấy `usage` của tin trợ lý CUỐI (input + cache đọc + cache tạo). Dùng để KHÔNG thức phiên lớn đã nguội bộ nhớ đệm (một lượt ~470k token ≈ 4,7 USD trên Opus).
 * Không đọc được / không tìm thấy ⇒ null (adapter coi là chưa biết ⇒ cho qua).
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const claudeProjectsDir = (env = process.env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

/** Tìm tệp hội thoại theo id (một cấp thư mục dự án). */
export function findTranscript(id, root = claudeProjectsDir()) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(String(id)) || !existsSync(root)) return null;
  try { for (const d of readdirSync(root)) { const f = join(root, d, `${id}.jsonl`); if (existsSync(f)) return f; } } catch { /* bỏ */ }
  return null;
}

/** usage của dòng JSONL cuối có message.usage ⇒ tổng token ngữ cảnh. Chỉ đọc ≤ tailBytes cuối tệp. */
/** #1113: dòng đánh dấu ngữ cảnh bị dọn (compact / /clear) — usage TRƯỚC mốc này không còn là ngữ cảnh hiện tại. */
const isResetLine = (l) => /"subtype"\s*:\s*"(?:compact_boundary|clear|session_clear)"/.test(l) || /<command-name>\s*\/clear\s*<\/command-name>/.test(l);
/** Đi ngược từ cuối, bỏ nhánh phụ (isSidechain); gặp mốc dọn TRƯỚC khi thấy usage ⇒ null (phiên vừa dọn/nạp lại: không cộng transcript trước dọn). */
export function contextTokensFromTail(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]; if (!l) continue;
    if (!l.includes('"usage"')) { if (isResetLine(l)) return null; continue; }
    try {
      const o = JSON.parse(l); if (o?.isSidechain === true) continue;
      const u = o?.message?.usage; if (!u) continue;
      const n = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* dòng cắt dở ở đầu đoạn đọc */ }
  }
  return null;
}

export function sessionContextTokens(id, { root, tailBytes = 400_000 } = {}) {
  const f = findTranscript(id, root); if (!f) return null;
  let fd;
  try {
    fd = openSync(f, 'r'); const size = fstatSync(fd).size; const len = Math.min(size, tailBytes); const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return contextTokensFromTail(buf.toString('utf8'));
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* bỏ */ } }
}

export const DEFAULT_RESUME_MAX_BYTES = 200 * 1024;
/** Kích thước tệp hội thoại (byte); không thấy ⇒ null. */
export function transcriptBytes(id, root) { const f = findTranscript(id, root); if (!f) return null; try { return statSync(f).size; } catch { return null; } }
/**
 * #1044: --resume CHỈ khi CÙNG thẻ với Run trước VÀ tệp hội thoại < maxBytes (mặc định 200KB, cấu hình resume_max_bytes). Còn lại ⇒ phiên MỚI + phiếu bàn giao.
 * ⇒ {ok, why}. Không biết thẻ / không đọc được tệp ⇒ KHÔNG resume.
 */
export function resumeVerdict({ session, card, prevCard, maxBytes = DEFAULT_RESUME_MAX_BYTES, root }) {
  if (!card || !prevCard || card !== prevCard) return { ok: false, why: `khác thẻ với lượt trước (${prevCard ?? 'chưa có'} → ${card ?? 'không thẻ'})` };
  const bytes = transcriptBytes(session, root);
  if (bytes == null) return { ok: false, why: 'không đọc được tệp hội thoại' };
  if (bytes >= maxBytes) return { ok: false, why: `hội thoại ${Math.round(bytes / 1024)}KB ≥ ${Math.round(maxBytes / 1024)}KB`, bytes };
  return { ok: true, bytes };
}

export const DEFAULT_MAX_CONTEXT = 100_000;
/** ⇒ {blocked: bool, tokens, max}. entry.allow_large = true ⇒ không chặn; entry.max_context_tokens đổi ngưỡng. */
export function contextGuard(id, entry = {}, opts = {}) {
  if (entry.allow_large) return { blocked: false };
  const max = Number(entry.max_context_tokens ?? DEFAULT_MAX_CONTEXT);
  const tokens = sessionContextTokens(id, opts);
  return { blocked: tokens != null && tokens > max, tokens, max };
}
