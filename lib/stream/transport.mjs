/**
 * lib/stream/transport.mjs — MỘT lần nối tới kênh `staff:` (WebSocket mặc định, SSE dự phòng). Node thuần: WebSocket toàn cục (Node ≥ 22) hoặc fetch.
 * connect({url, key, since, sse, onFrame}) ⇒ {transport: 'ws'|'sse', ack(ids), ping(), close(), done: Promise<{code, reason, status, error}>}
 * Khoá CHỈ đi ở header Authorization (KHÔNG lên URL). Không tự nối lại — vòng nối lại ở session.mjs.
 */
import { parseFrame, sseParser, streamUrls } from './protocol.mjs';

export const wsAvailable = () => typeof globalThis.WebSocket === 'function';

export function connect({ mcpUrl, key, since = null, who = null, sse = false, onFrame, onOpen }) {
  const urls = streamUrls(mcpUrl, { since, who });
  return !sse && wsAvailable() ? connectWs(urls.ws, key, onFrame, onOpen) : connectSse(urls.sse, key, since, onFrame, onOpen);
}

function connectWs(url, key, onFrame, onOpen) {
  let ws; let finish;
  const done = new Promise((r) => { finish = r; });
  try { ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } }); } catch (e) { finish({ code: 0, reason: '', error: e?.message ?? String(e) }); return { transport: 'ws', ack() {}, ping() {}, close() {}, done }; }
  let opened = false; let timer = null;
  ws.onopen = () => { opened = true; onOpen?.(); timer = setInterval(() => { try { if (ws.readyState === 1) ws.send('ping'); } catch { /* đóng sau */ } }, 45_000); timer.unref?.(); };
  ws.onmessage = (m) => { const f = parseFrame(typeof m.data === 'string' ? m.data : ''); if (f) onFrame(f); };
  // nâng cấp bị từ chối (401/403/429, mạng chặn…): Node chỉ bắn `error`, KHÔNG bắn `close` ⇒ phải tự kết thúc lần nối này, nếu không vòng nối lại treo mãi
  ws.onerror = () => { if (!opened) { clearInterval(timer); finish({ code: 1006, reason: '', opened: false, error: 'nâng cấp WebSocket thất bại' }); } };
  ws.onclose = (c) => { clearInterval(timer); finish({ code: c.code ?? 0, reason: c.reason ?? '', opened }); };
  return {
    transport: 'ws',
    ack(ids) { try { if (ws.readyState === 1) { ws.send(JSON.stringify({ op: 'ack', ids })); return true; } } catch { /* rơi về MCP */ } return false; },
    ping() { try { if (ws.readyState === 1) ws.send(JSON.stringify({ op: 'ping' })); } catch { /* bỏ */ } },
    close() { try { ws.close(1000, 'client'); } catch { /* bỏ */ } },
    done,
  };
}

function connectSse(url, key, since, onFrame, onOpen) {
  const ac = new AbortController();
  const headers = { Authorization: `Bearer ${key}`, Accept: 'text/event-stream' };
  if (since != null) headers['Last-Event-ID'] = String(since);
  const done = (async () => {
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok) { let body = null; try { body = await res.json(); } catch { /* không có thân JSON */ } return { code: 0, status: res.status, reason: body?.code ?? '', error: body?.error ?? `HTTP ${res.status}` }; }
      onOpen?.();
      const p = sseParser(); const dec = new TextDecoder();
      for await (const chunk of res.body) for (const b of p.feed(dec.decode(chunk, { stream: true }))) {
        if (b.event === 'reconnect') return { code: 0, reason: 'reconnect', opened: true }; // máy chủ chủ động kết thúc sau 5': nối lại ngay
        const f = parseFrame(b.data, b.event); if (f) onFrame(f);
      }
      return { code: 0, reason: 'eof', opened: true };
    } catch (e) { return ac.signal.aborted ? { code: 1000, reason: 'client', opened: true } : { code: 0, reason: '', error: e?.message ?? String(e) }; }
  })();
  return { transport: 'sse', ack() { return false; }, ping() {}, close() { ac.abort(); }, done };
}
