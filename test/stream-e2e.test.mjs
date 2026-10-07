import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCursor, saveCursor } from '../lib/stream/cursor.mjs';
import { runStream } from '../lib/stream/session.mjs';
import { evt, hello, startFakeServer, waitFor } from './helpers/fake-stream-server.mjs';

process.env.DBIO_STREAM_DIR = mkdtempSync(join(tmpdir(), 'stream-'));
const KEY = 'sk_p2_abcdefghijklmnopqrstuvwxyz0123456789';
let n = 0;
const uniq = () => `T861_e2e_${process.pid}_${++n}`;
const open = (srv, name, extra = {}) => {
  const delivered = [];
  const s = runStream({ name, consumer: 'e2e', cfg: { key: KEY, mcp_url: srv.mcpUrl }, coalesceMs: 0, tickMs: 20, log: () => {}, deliver: async (b) => { delivered.push(...b.map((x) => ({ ...x, at_recv: Date.now() }))); return true; }, ...extra });
  s.done.catch(() => {});
  return { s, delivered };
};

test('WS: khoá chỉ ở header (không lên URL); assign ⇒ deliver < 3s; client ack đúng id; con trỏ lưu đĩa', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(5)) });
  const name = uniq();
  const { s, delivered } = open(srv, name);
  try {
    await waitFor(() => srv.conns.length === 1);
    const c = srv.conns[0];
    assert.equal(c.kind, 'ws'); assert.equal(c.auth, `Bearer ${KEY}`);
    assert.ok(!c.url.includes(KEY) && !/key=/.test(c.url));
    const t0 = Date.now(); c.send(evt(6));
    await waitFor(() => delivered.length === 1, 3000);
    assert.ok(delivered[0].at_recv - t0 < 3000, `độ trễ ${delivered[0].at_recv - t0}ms`);
    assert.equal(delivered[0].cls, 'urgent'); assert.equal(delivered[0].task, '1#6');
    await waitFor(() => c.received.some((f) => f.op === 'ack'));
    assert.deepEqual(c.received.find((f) => f.op === 'ack'), { op: 'ack', ids: [6] });
    assert.equal(loadCursor(name, 'e2e', new URL(srv.mcpUrl).hostname), 6);
    assert.deepEqual(s.queue, []);
  } finally { s.stop(); await srv.stop(); }
});

test('mất kênh ⇒ nối lại CÓ since=<con trỏ>, tin lặp bị khử trùng, tin mới không sót', async () => {
  let round = 0;
  const srv = await startFakeServer({ onConnect: (c) => { c.send(hello(0)); round++; if (round === 1) { c.send(evt(10)); setTimeout(() => c.close(1011), 150); } else { c.send(evt(10)); c.send(evt(11)); } } });
  const name = uniq();
  const { s, delivered } = open(srv, name);
  try {
    await waitFor(() => delivered.length === 2, 8000);
    assert.deepEqual(delivered.map((d) => d.id), [10, 11]);
    assert.equal(srv.conns.length, 2);
    assert.match(srv.conns[1].url, /since=10/);
    assert.equal(loadCursor(name, 'e2e', new URL(srv.mcpUrl).hostname), 11);
  } finally { s.stop(); await srv.stop(); }
});

test('khởi động lại tiến trình: nạp con trỏ từ đĩa ⇒ since đúng, không nhận lại tin cũ', async () => {
  const name = uniq();
  const srv1 = await startFakeServer({ onConnect: (c) => { c.send(hello(0)); c.send(evt(20)); } });
  const a = open(srv1, name);
  await waitFor(() => a.delivered.length === 1); a.s.stop(); await srv1.stop();
  const srv2 = await startFakeServer({ onConnect: (c) => { c.send(hello(0)); c.send(evt(20)); c.send(evt(21)); } });
  const b = open(srv2, name);
  try {
    await waitFor(() => b.delivered.length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(b.delivered.map((d) => d.id), [21]);
    assert.match(srv2.conns[0].url, /since=20/);
  } finally { b.s.stop(); await srv2.stop(); }
});

test('SSE (WS không dùng được): Last-Event-ID khi nối lại; ack đi đường MCP (ackFallback)', async () => {
  let round = 0;
  const srv = await startFakeServer({ onConnect: (c) => { c.send(hello(0)); round++; if (round === 1) { c.send(evt(30)); setTimeout(() => c.close(), 150); } else c.send(evt(31)); } });
  const acked = [];
  const name = uniq();
  const { s, delivered } = open(srv, name, { sse: true, ackFallback: async (ids) => { acked.push(...ids); } });
  try {
    await waitFor(() => delivered.length === 2, 8000);
    assert.ok(srv.conns.every((c) => c.kind === 'sse'));
    assert.equal(srv.conns[0].auth, `Bearer ${KEY}`);
    assert.equal(srv.conns[1].lastEventId, '30');
    await waitFor(() => acked.includes(30) && acked.includes(31));
  } finally { s.stop(); await srv.stop(); }
});

test('lọc: tin tự mình gửi / bản sao (không phải thư ký) bị bỏ + tự ack, KHÔNG thức; tin thường không thức ngay', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const name = uniq();
  const { s, delivered } = open(srv, name);
  try {
    await waitFor(() => srv.conns.length === 1);
    const c = srv.conns[0];
    c.send(evt(40, { type: 'mention', kind: 'mention', from: { character_id: 1001 }, text: 'tự nhắc' })); // self
    c.send(evt(41, { type: 'mention', kind: 'mention', copy: true, text: 'bản sao', prio: 'normal' }));   // copy
    c.send(evt(42, { type: 'children_done', kind: 'children_done', text: 'thẻ con xong', prio: 'normal' }));  // thường: gom, chưa thức
    await waitFor(() => c.received.some((f) => f.op === 'ack' && f.ids.includes(41)));
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(delivered, []);
    assert.equal(s.queue.length, 1); assert.equal(s.queue[0].id, 42);
    const acks = c.received.filter((f) => f.op === 'ack').flatMap((f) => f.ids);
    assert.ok(acks.includes(40) && acks.includes(41) && !acks.includes(42));
    assert.equal(loadCursor(name, 'e2e', new URL(srv.mcpUrl).hostname), 42, 'con trỏ vẫn tiến (tin thường nằm trong hàng đợi đĩa)');
  } finally { s.stop(); await srv.stop(); }
});

test('thư ký: bản sao tin @nhắc VẪN thức (việc của thư ký)', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const { s, delivered } = open(srv, uniq(), { secretary: true });
  try {
    await waitFor(() => srv.conns.length === 1);
    srv.conns[0].send(evt(50, { type: 'mention', kind: 'mention', copy: true, text: '@NV1 làm đi', prio: 'normal' }));
    await waitFor(() => delivered.length === 1, 3000);
    assert.equal(delivered[0].cls, 'urgent');
  } finally { s.stop(); await srv.stop(); }
});

test('deliver trả false ⇒ giữ tin (không ack, không mất), thử lại ở nhịp sau', async () => {
  const srv = await startFakeServer({ onConnect: (c) => { c.send(hello(0)); c.send(evt(60)); } });
  let calls = 0; const ok = { v: false };
  const s = runStream({ name: uniq(), consumer: 'e2e', cfg: { key: KEY, mcp_url: srv.mcpUrl }, coalesceMs: 0, tickMs: 20, log: () => {}, deliver: async () => { calls++; return ok.v; } });
  s.done.catch(() => {});
  try {
    await waitFor(() => calls >= 3, 3000);
    assert.equal(s.queue.length, 1);
    assert.ok(!srv.conns[0].received.some((f) => f.op === 'ack'));
    ok.v = true;
    await waitFor(() => s.queue.length === 0);
    await waitFor(() => srv.conns[0].received.some((f) => f.op === 'ack'));
  } finally { s.stop(); await srv.stop(); }
});

test('hàng đợi bền: tiến trình chết khi chưa thức ⇒ khởi động lại vẫn thức đúng tin đó (không sót)', async () => {
  const name = uniq();
  const srv = await startFakeServer({ onConnect: (c) => { c.send(hello(0)); c.send(evt(70)); } });
  const a = runStream({ name, consumer: 'e2e', cfg: { key: KEY, mcp_url: srv.mcpUrl }, coalesceMs: 0, tickMs: 20, log: () => {}, deliver: async () => false });
  a.done.catch(() => {});
  await waitFor(() => a.queue.length === 1); a.stop(); await srv.stop();
  const srv2 = await startFakeServer({ onConnect: (c) => c.send(hello(70)) }); // máy chủ không gửi lại tin 70
  const got = [];
  const b = runStream({ name, consumer: 'e2e', cfg: { key: KEY, mcp_url: srv2.mcpUrl }, coalesceMs: 0, tickMs: 20, log: () => {}, deliver: async (x) => { got.push(...x); return true; } });
  b.done.catch(() => {});
  try { await waitFor(() => got.length === 1, 3000); assert.equal(got[0].id, 70); } finally { b.stop(); await srv2.stop(); }
});

test('khoá bị từ chối (HTTP 401/403 qua SSE) ⇒ lỗi NẶNG, không nối lại vô hạn', async () => {
  const srv = await startFakeServer({ rejectStatus: 403 });
  const name = uniq();
  const s = runStream({ name, consumer: 'e2e', cfg: { key: KEY, mcp_url: srv.mcpUrl }, sse: true, deliver: async () => true, log: () => {} });
  try {
    await assert.rejects(s.done, (e) => e.fatal === true && /403/.test(e.message) && !e.message.includes(KEY));
  } finally { s.stop(); await srv.stop(); }
});

test('WS bị từ chối khi nâng cấp ⇒ rơi về SSE để biết nguyên nhân, rồi dừng (không hammer)', async () => {
  const srv = await startFakeServer({ rejectStatus: 401 });
  const s = runStream({ name: uniq(), consumer: 'e2e', cfg: { key: KEY, mcp_url: srv.mcpUrl }, deliver: async () => true, log: () => {}, backoff: () => 10 });
  try { await assert.rejects(s.done, (e) => e.fatal === true && /401/.test(e.message)); } finally { s.stop(); await srv.stop(); }
});

test('tệp khoá thiếu ⇒ lỗi nặng rõ ràng, không in khoá', () => {
  assert.throws(() => runStream({ name: 'KHONG_CO_NHAN_VIEN_NAY_861', consumer: 'e2e', deliver: async () => true }), (e) => e.fatal === true && /Chưa có khoá/.test(e.message));
});


test('deliver chậm: không chạy chồng 2 lượt lên cùng một lô (tick có khoá)', async () => {
  const srv = await startFakeServer({ onConnect: (c) => { c.send(hello(0)); c.send(evt(80)); } });
  let active = 0; let maxActive = 0; let calls = 0;
  const s = runStream({ name: uniq(), consumer: 'e2e', cfg: { key: KEY, mcp_url: srv.mcpUrl }, coalesceMs: 0, tickMs: 10, log: () => {}, deliver: async () => { calls++; active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 300)); active--; return true; } });
  s.done.catch(() => {});
  try { await waitFor(() => s.queue.length === 0 && calls >= 1, 3000); await new Promise((r) => setTimeout(r, 200)); assert.equal(maxActive, 1); assert.equal(calls, 1); } finally { s.stop(); await srv.stop(); }
});

test('#872 fresh dù ĐÃ CÓ con trỏ của phiên trước trên đĩa: backlog cũ KHÔNG đánh thức phiên mới', async () => {
  // Ca thật 7/10: chủ clear phiên ⇒ phiên mới chạy `listen --fresh`, nhưng máy đã có con trỏ của phiên TRƯỚC
  // ⇒ trước khi sửa, --fresh bị bỏ qua và backlog tích luỹ lúc phiên vắng mặt xả ra đánh thức ngay.
  const srv = await startFakeServer({ onConnect: (c) => { c.send(hello(100)); c.send(evt(50)); c.send(evt(60)); c.send({ type: 'caught_up', v: 1, cursor: 100, more: false }); } });
  const name = uniq(); const host = new URL(srv.mcpUrl).hostname;
  saveCursor(name, 'e2e', host, 40); // phiên trước đã nghe tới 40
  const { s, delivered } = open(srv, name, { fresh: true });
  try {
    await waitFor(() => loadCursor(name, 'e2e', host) === 100, 4000); // hello ⇒ nhảy thẳng con trỏ máy chủ
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(delivered, []);
  } finally { s.stop(); await srv.stop(); }
});

test('#872 fresh KHÔNG áp cho lần NỐI LẠI: tin đến lúc mất kênh vẫn được giao', async () => {
  let round = 0;
  const srv = await startFakeServer({ onConnect: (c) => { round++; if (round === 1) { c.send(hello(100)); c.send({ type: 'caught_up', v: 1, cursor: 100, more: false }); setTimeout(() => c.close(1011), 150); } else { c.send(hello(200)); c.send(evt(150)); } } });
  const { s, delivered } = open(srv, uniq(), { fresh: true });
  try { await waitFor(() => delivered.length >= 1, 6000); assert.deepEqual(delivered.map((d) => d.id), [150]); } finally { s.stop(); await srv.stop(); }
});

test('fresh lần đầu: bỏ tin chưa đọc CŨ nhưng giữ tin còn mới (freshKeepMs); nối lại không xử lý lại', async () => {
  const old = new Date(Date.now() - 48 * 3_600_000).toISOString(); const young = new Date(Date.now() - 600_000).toISOString();
  let round = 0;
  const srv = await startFakeServer({ onConnect: (c) => { round++; c.send(hello(100)); if (round === 1) { c.send(evt(50, { at: old })); c.send(evt(60, { at: young })); c.send({ type: 'caught_up', v: 1, cursor: 100, more: false }); setTimeout(() => c.close(1011), 200); } else { c.send(evt(60, { at: young })); } } });
  const { s, delivered } = open(srv, uniq(), { fresh: true, freshKeepMs: 6 * 3_600_000 });
  try { await waitFor(() => delivered.length >= 1, 4000); await new Promise((r) => setTimeout(r, 1800)); assert.deepEqual(delivered.map((d) => d.id), [60]); } finally { s.stop(); await srv.stop(); }
});
