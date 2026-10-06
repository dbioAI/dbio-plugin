/**
 * lib/stream/protocol.mjs — phần THUẦN của client kênh sự kiện `staff:` (hợp đồng v1: backend/docs/staff-stream.md). Không IO, không mạng; có test.
 * Máy chủ đẩy tin; client giữ con trỏ (id hộp thư), khử trùng theo id, nối lại có lùi, bỏ qua trường/loại lạ.
 */

/** Lùi dần 1s → 2s → 4s … tối đa 60s, ±20% ngẫu nhiên (rnd ∈ [0,1)). attempt tính từ 0. */
export function backoffMs(attempt, rnd = Math.random()) {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * rnd));
}

/** Địa chỉ WS / SSE từ mcp_url của tệp khoá. since = con trỏ (null ⇒ không truyền). KHÔNG BAO GIỜ đặt khoá lên URL. */
export function streamUrls(mcpUrl, { since = null, who = null } = {}) {
  const u = new URL(mcpUrl);
  const q = new URLSearchParams();
  if (since != null) q.set('since', String(since));
  if (who) q.set('who', who);
  const qs = q.toString() ? `?${q}` : '';
  return { ws: `${u.protocol === 'http:' ? 'ws' : 'wss'}://${u.host}/staff/stream${qs}`, sse: `${u.protocol}//${u.host}/staff/stream/sse${qs}`, ticket: `${u.protocol}//${u.host}/staff/stream/ticket` };
}

/** Bộ đọc SSE tăng dần: feed(chuỗi) ⇒ [{event, id, data}] cho mỗi khối đã đủ (dòng trống kết thúc); dòng `:` (keepalive) bị bỏ. */
export function sseParser() {
  let buf = '';
  let cur = { event: 'message', id: null, data: [] };
  return {
    feed(chunk) {
      buf += chunk;
      const out = [];
      let i;
      while ((i = buf.search(/\r\n|\n|\r/)) >= 0) {
        const line = buf.slice(0, i);
        const nl = buf.slice(i).startsWith('\r\n') ? 2 : 1;
        if (buf.length - i === 1 && buf[i] === '\r') break; // CR cuối đệm: chưa biết có LF theo sau không
        buf = buf.slice(i + nl);
        if (line === '') { if (cur.data.length) out.push({ event: cur.event, id: cur.id, data: cur.data.join('\n') }); cur = { event: 'message', id: null, data: [] }; continue; }
        if (line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const f = c < 0 ? line : line.slice(0, c);
        const v = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (f === 'event') cur.event = v; else if (f === 'id') cur.id = v; else if (f === 'data') cur.data.push(v);
      }
      return out;
    },
  };
}

/** Khung JSON (WS) / khối SSE ⇒ đối tượng khung, hoặc null nếu hỏng (bỏ qua, không làm rơi kết nối). SSE: type lấy từ `event:` nếu thân thiếu. */
export function parseFrame(raw, sseEvent = null) {
  let f;
  try { f = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return null; }
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  if (!f.type && sseEvent && sseEvent !== 'message') f.type = sseEvent;
  return typeof f.type === 'string' ? f : null;
}

const SYSTEM = new Set(['hello', 'caught_up', 'pong', 'acked', 'error', 'reconnect']);
/** Khung hệ thống (không phải tin nhân viên) — client bỏ qua type lạ nhưng phải có id số mới là tin. */
export const isSystemFrame = (f) => SYSTEM.has(f?.type) || !Number.isSafeInteger(f?.id) || f.id < 0;

/** Khử trùng theo id + con trỏ: seen(id) ⇒ true nếu đã xử lý (id ≤ con trỏ hoặc đã gặp). Giao ÍT NHẤT MỘT LẦN nên nối lại sẽ lặp tin. */
export function dedupe(cursor = null, keep = 2000) {
  let cur = cursor; const ids = new Set();
  return {
    isDup(id) { return (cur != null && id <= cur) || ids.has(id); },
    mark(id) { ids.add(id); if (ids.size > keep) ids.delete(ids.values().next().value); if (cur == null || id > cur) cur = id; },
    get cursor() { return cur; },
    set cursor(v) { if (v != null && (cur == null || v > cur)) cur = v; },
  };
}

/**
 * Khung sự kiện ⇒ dạng "tin hộp thư" mà bộ lọc watch-filter đã hiểu (cùng quy tắc self / copy / dup / owner-wait…).
 * `prio` của máy chủ chỉ là GỢI Ý: phân loại cuối vẫn do classify() ở client (một nguồn luật).
 */
export function eventToItem(e) {
  return {
    id: e.id, kind: e.kind ?? e.type, text: e.text ?? '', task: e.task ?? null, at: e.at,
    from_character_id: e.from?.character_id ?? null, from_user_id: e.from?.user_id ?? null,
    state: e.copy ? 'copy' : null, ref_id: e.ref_id ?? null, to_id: e.to?.id ?? null, type: e.type, prio: e.prio ?? 'normal',
  };
}

/** Mã đóng WS ⇒ cách nối lại: {retry: bool, backoff: bool}. 4001 = hết 60' xác thực lại ngay; 4002 = bị kết nối mới thay ⇒ thôi. */
export function closePolicy(code) {
  if (code === 4001) return { retry: true, backoff: false };
  if (code === 4002) return { retry: false, backoff: false };
  return { retry: true, backoff: true };
}

/** HTTP lỗi trước khi nâng cấp ⇒ có nên thử lại không. 401/403/400 = khoá/đối số sai (không thử lại mù); 429 + 5xx thử lại có lùi. */
export function httpPolicy(status) {
  if (status === 429 || status >= 500) return { retry: true };
  return { retry: false };
}
