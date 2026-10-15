/**
 * lib/agentd/failure.mjs — phân loại lỗi CLI (#1060 phần 4): rate-limit / hết quota / lỗi đăng nhập ⇒ {reason, retry_at}.
 * reason khớp worker_beat accounts[].retry_reason (§84): rate_limit | quota | auth. retry_at = ISO; auth không có giờ (cần đăng nhập lại).
 * Giờ hết hạn đọc được từ đầu ra ("resets at 3pm", "reset in 2 hours") — không đọc được ⇒ mặc định (rate 10', quota 60'), trần 8 ngày.
 */
const MAX_MS = 8 * 24 * 3_600_000;
const DEFAULTS = { rate_limit: 10 * 60_000, quota: 60 * 60_000 };

export function classifyFailure(text, now = Date.now()) {
  const s = String(text ?? '');
  if (!s) return null;
  let reason = null;
  if (/oauth|token (has )?expired|not logged in|please run \/?login|authentication[_ ]error|invalid api key|\b401\b/i.test(s)) reason = 'auth';
  else if (/usage limit|quota|limit reached|out of (extra )?usage|credit balance|weekly limit|5-hour limit/i.test(s)) reason = 'quota';
  else if (/rate.?limit|too many requests|\b429\b|overloaded_error/i.test(s)) reason = 'rate_limit';
  if (!reason) return null;
  if (reason === 'auth') return { reason };
  let ms = DEFAULTS[reason];
  const rel = /(?:reset|retry)[^.\d]{0,20}(?:in|after)\s+(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d)/i.exec(s);
  if (rel) { const n = Number(rel[1]); const u = rel[2].toLowerCase()[0]; ms = n * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[u] ?? 60_000); }
  else {
    const abs = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(s);
    if (abs) { let h = Number(abs[1]) % 12; if (/pm/i.test(abs[3])) h += 12; const d = new Date(now); d.setHours(h, Number(abs[2] ?? 0), 0, 0); if (d.getTime() <= now) d.setDate(d.getDate() + 1); ms = d.getTime() - now; }
  }
  ms = Math.min(Math.max(ms, 60_000), MAX_MS);
  return { reason, retry_at: new Date(now + ms).toISOString() };
}
