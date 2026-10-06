/**
 * Máy chủ giả của kênh `staff:` cho test: WebSocket tự viết (bắt tay + khung văn bản, đủ dùng) và SSE. Ghi lại header/URL từng lần nối, khung client gửi lên.
 * srv.conns = [{kind:'ws'|'sse', url, auth, lastEventId, received: [khung client gửi], send(obj), close(code)}]; srv.onConnect(conn) cho kịch bản.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsText = (s) => { const p = Buffer.from(s); const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]); return Buffer.concat([h, p]); };
const wsClose = (code) => Buffer.from([0x88, 2, code >> 8, code & 255]);

export async function startFakeServer({ onConnect = () => {}, rejectStatus = null } = {}) {
  const srv = { conns: [], onConnect, rejectStatus };
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/staff/stream/sse')) { res.writeHead(404).end(); return; }
    if (srv.rejectStatus) { res.writeHead(srv.rejectStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify({ v: 1, success: false, code: 'not_staff_key', error: 'khoá không phải của nhân viên' })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const conn = { kind: 'sse', url: req.url, auth: req.headers.authorization ?? null, lastEventId: req.headers['last-event-id'] ?? null, received: [],
      send: (o) => res.write(`event: ${o.type}\n${o.id != null ? `id: ${o.id}\n` : ''}data: ${JSON.stringify(o)}\n\n`), close: () => res.end() };
    res.on('close', () => { conn.closed = true; });
    srv.conns.push(conn); srv.onConnect(conn);
  });
  server.on('upgrade', (req, socket) => {
    if (srv.rejectStatus) { socket.end(`HTTP/1.1 ${srv.rejectStatus} X\r\ncontent-length: 0\r\n\r\n`); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = { kind: 'ws', url: req.url, auth: req.headers.authorization ?? null, lastEventId: null, received: [], send: (o) => socket.write(wsText(JSON.stringify(o))), close: (code = 1000) => { socket.write(wsClose(code)); socket.end(); } };
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const op = buf[0] & 15; let len = buf[1] & 127; let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        const masked = (buf[1] & 128) !== 0; const need = off + (masked ? 4 : 0) + len;
        if (buf.length < need) return;
        const mask = masked ? buf.subarray(off, off + 4) : null; const p = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
        if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i % 4];
        buf = buf.subarray(need);
        if (op === 1) { const s = p.toString('utf8'); try { conn.received.push(JSON.parse(s)); } catch { conn.received.push(s); } }
        if (op === 8) { try { socket.write(wsClose(1000)); socket.end(); } catch { /* đóng rồi */ } }
      }
    });
    socket.on('close', () => { conn.closed = true; }); socket.on('error', () => {});
    srv.conns.push(conn); srv.onConnect(conn);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  srv.port = server.address().port; srv.mcpUrl = `http://127.0.0.1:${srv.port}/mcp`;
  srv.stop = () => new Promise((r) => { for (const c of srv.conns) { try { c.close(); } catch { /* bỏ */ } } server.closeAllConnections?.(); server.close(() => r()); });
  return srv;
}

export const waitFor = async (fn, ms = 5000, step = 25) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, step)); } throw new Error(`hết ${ms}ms chờ điều kiện`); };

export const evt = (id, over = {}) => ({ type: 'assigned', v: 1, id, at: new Date().toISOString(), to: { id: 1001, name: 'T' }, task: `1#${id}`, board_id: 1, task_id: id, from: { user_id: 2, character_id: 901 }, text: `việc số ${id}`, kind: 'assign', prio: 'urgent', copy: false, ...over });
export const hello = (cursor = 0) => ({ type: 'hello', v: 1, store_id: 2, self: { id: 1001, name: 'T' }, who: [{ id: 1001, name: 'T' }], since: null, cursor, backlog: 0, poll_ms: 2000, max_age_s: 3600 });
