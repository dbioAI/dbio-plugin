/**
 * lib/agentd/failure.mjs — phân loại lỗi CLI (#1060 phần 4): rate-limit / hết quota / lỗi đăng nhập ⇒ {reason, retry_at}.
 * reason khớp worker_beat accounts[].retry_reason (§84): rate_limit | quota | auth. retry_at = ISO; auth không có giờ (cần đăng nhập lại).
 * Giờ hết hạn đọc được từ đầu ra ("resets at 3pm", "reset in 2 hours") — không đọc được ⇒ mặc định (rate 10', quota 60'), trần 8 ngày.
 */
const MAX_MS = 8 * 24 * 3_600_000;
const DEFAULTS = { rate_limit: 10 * 60_000, quota: 60 * 60_000 };

const VN_MS = 7 * 3_600_000; // Asia/Ho_Chi_Minh = UTC+7 cố định (không DST)
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** #1094: "resets 3pm" · "resets at 9:30am" · "resets Oct 22, 9am" · "resets Oct 22 at 9:00 am (Asia/Saigon)" ⇒ ms epoch theo giờ Asia/Ho_Chi_Minh; không đọc được ⇒ null. */
export function parseResetAt(s, now = Date.now()) {
  const m = /resets?\s+(?:at\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(String(s));
  if (!m) return null;
  const vn = new Date(now + VN_MS); const y = vn.getUTCFullYear();
  let h = Number(m[3]) % 12; if (/pm/i.test(m[5])) h += 12; const min = Number(m[4] ?? 0);
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()); if (mo < 0) return null;
    let t = Date.UTC(y, mo, Number(m[2]), h, min) - VN_MS; if (t <= now) t = Date.UTC(y + 1, mo, Number(m[2]), h, min) - VN_MS;
    return t;
  }
  let t = Date.UTC(y, vn.getUTCMonth(), vn.getUTCDate(), h, min) - VN_MS; if (t <= now) t += 86_400_000;
  return t;
}

export function classifyFailure(text, now = Date.now()) {
  const s = String(text ?? '');
  if (!s) return null;
  let reason = null;
  if (/oauth|token (has )?expired|not logged in|please run \/?login|authentication[_ ]error|invalid api key|\b401\b/i.test(s)) reason = 'auth';
  else if (/usage limit|quota|limit reached|out of (extra )?usage|credit balance|hit your (?:\w+[ -])?limit|weekly limit|5-hour limit/i.test(s)) reason = 'quota';
  else if (/rate.?limit|too many requests|\b429\b|overloaded_error/i.test(s)) reason = 'rate_limit';
  if (!reason) return null;
  if (reason === 'auth') return { reason };
  let ms = DEFAULTS[reason];
  const rel = /(?:reset|retry)[^.\d]{0,20}(?:in|after)\s+(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h|day|d)/i.exec(s);
  if (rel) { const n = Number(rel[1]); const u = rel[2].toLowerCase()[0]; ms = n * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[u] ?? 60_000); }
  else { const t = parseResetAt(s, now); if (t != null) ms = t - now; }
  ms = Math.min(Math.max(ms, 60_000), MAX_MS);
  return { reason, retry_at: new Date(now + ms).toISOString(), ...(reason === 'quota' ? { window: /weekly/i.test(s) ? 'weekly' : /5-hour|five-hour/i.test(s) ? '5h' : null } : {}) };
}
