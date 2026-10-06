/**
 * adapter hermes — đẩy việc tới webhook của Hermes: POST JSON {staff, prompt, events, at}. Khoá ký (tuỳ chọn) lấy từ BIẾN MÔI TRƯỜNG tên `secret_env`
 * (giá trị không bao giờ nằm trong tệp cấu hình / log) ⇒ header `X-Dbio-Signature: sha256=<HMAC của thân>`.
 * entry: { url (https, hoặc http tới localhost), secret_env, timeout_s }
 */
import { createHmac } from 'node:crypto';

export const urlAllowed = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)); } catch { return false; } };

export default {
  name: 'hermes',
  async wake({ staff, entry, prompt, events = [], env = process.env, fetchFn = fetch }) {
    if (!urlAllowed(entry.url)) return { ok: false, detail: `${staff}: "url" phải là https (hoặc http tới localhost)` };
    const body = JSON.stringify({ staff, prompt, events: events.map((e) => ({ id: e.id, kind: e.kind, task: e.task, text: String(e.text ?? '').slice(0, 500) })), at: new Date().toISOString() });
    const headers = { 'content-type': 'application/json' };
    if (entry.secret_env) { const s = env[entry.secret_env]; if (!s) return { ok: false, detail: `${staff}: biến môi trường ${entry.secret_env} chưa đặt` }; headers['x-dbio-signature'] = `sha256=${createHmac('sha256', s).update(body).digest('hex')}`; }
    try {
      const res = await fetchFn(entry.url, { method: 'POST', redirect: 'manual', headers, body, signal: AbortSignal.timeout((entry.timeout_s ?? 15) * 1000) });
      return res.ok ? { ok: true, detail: `webhook ${res.status}` } : { ok: false, detail: `webhook từ chối HTTP ${res.status}` };
    } catch (e) { return { ok: false, detail: `webhook lỗi: ${e?.message ?? e}` }; }
  },
};
