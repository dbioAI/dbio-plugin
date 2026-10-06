/**
 * lib/agentd/context-size.mjs — ước lượng NGỮ CẢNH hiện tại của một phiên Claude Code (token) từ tệp hội thoại ~/.claude/projects/<dự án>/<cliSessionId>.jsonl:
 * lấy `usage` của tin trợ lý CUỐI (input + cache đọc + cache tạo). Dùng để KHÔNG thức phiên lớn đã nguội bộ nhớ đệm (một lượt ~470k token ≈ 4,7 USD trên Opus).
 * Không đọc được / không tìm thấy ⇒ null (adapter coi là chưa biết ⇒ cho qua).
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
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
export function contextTokensFromTail(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]; if (!l.includes('"usage"')) continue;
    try {
      const u = JSON.parse(l)?.message?.usage; if (!u) continue;
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

export const DEFAULT_MAX_CONTEXT = 100_000;
/** ⇒ {blocked: bool, tokens, max}. entry.allow_large = true ⇒ không chặn; entry.max_context_tokens đổi ngưỡng. */
export function contextGuard(id, entry = {}, opts = {}) {
  if (entry.allow_large) return { blocked: false };
  const max = Number(entry.max_context_tokens ?? DEFAULT_MAX_CONTEXT);
  const tokens = sessionContextTokens(id, opts);
  return { blocked: tokens != null && tokens > max, tokens, max };
}
