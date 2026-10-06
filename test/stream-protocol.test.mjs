import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoffMs, closePolicy, dedupe, eventToItem, httpPolicy, isSystemFrame, parseFrame, sseParser, streamUrls } from '../lib/stream/protocol.mjs';

test('backoff: 1s → 2s → 4s … trần 60s, ±20%', () => {
  assert.equal(backoffMs(0, 0.5), 1000);
  assert.equal(backoffMs(1, 0.5), 2000);
  assert.equal(backoffMs(3, 0.5), 8000);
  assert.equal(backoffMs(20, 0.5), 60_000);
  assert.equal(backoffMs(0, 0), 800);
  assert.equal(backoffMs(0, 0.999), 1200);
  assert.equal(backoffMs(-5, 0.5), 1000);
});

test('streamUrls: since/who lên query, KHOÁ không bao giờ lên URL, http ⇒ ws', () => {
  const u = streamUrls('https://mcp.dbio.vn/mcp', { since: 42, who: '*' });
  assert.equal(u.ws, 'wss://mcp.dbio.vn/staff/stream?since=42&who=*');
  assert.equal(u.sse, 'https://mcp.dbio.vn/staff/stream/sse?since=42&who=*');
  assert.equal(u.ticket, 'https://mcp.dbio.vn/staff/stream/ticket');
  assert.equal(streamUrls('https://mcp.dbio.vn/mcp').ws, 'wss://mcp.dbio.vn/staff/stream');
  assert.equal(streamUrls('http://127.0.0.1:8787/mcp', { since: 0 }).ws, 'ws://127.0.0.1:8787/staff/stream?since=0'); // since=0 vẫn truyền
  for (const v of Object.values(u)) assert.doesNotMatch(v, /key|api_key|sk_/);
});

test('sseParser: khối đủ, chia mảnh bất kỳ, CRLF, keepalive, nhiều dòng data', () => {
  const p = sseParser();
  assert.deepEqual(p.feed(': keepalive\n\n'), []);
  assert.deepEqual(p.feed('event: assigned\nid: 7\nda'), []);
  assert.deepEqual(p.feed('ta: {"a":1}\n\nevent: x\r\ndata: l1\r\ndata: l2\r\n\r\n'), [
    { event: 'assigned', id: '7', data: '{"a":1}' }, { event: 'x', id: null, data: 'l1\nl2' },
  ]);
  assert.deepEqual(p.feed('data: {"b":2}\n\n'), [{ event: 'message', id: null, data: '{"b":2}' }]);
});

test('sseParser: CR cuối đệm chờ LF, không tách đôi khối', () => {
  const p = sseParser();
  assert.deepEqual(p.feed('data: 1\r'), []);
  assert.deepEqual(p.feed('\n\r\n'), [{ event: 'message', id: null, data: '1' }]);
});

test('parseFrame: hỏng ⇒ null (không rơi kết nối); SSE lấy type từ event; type lạ vẫn qua', () => {
  assert.equal(parseFrame('không phải json'), null);
  assert.equal(parseFrame('[1,2]'), null);
  assert.equal(parseFrame('{"x":1}'), null);
  assert.equal(parseFrame('{"x":1}', 'assigned').type, 'assigned');
  assert.equal(parseFrame('{"type":"tuong_lai","v":1}').type, 'tuong_lai');
});

test('isSystemFrame: hello/caught_up/pong/acked/error và khung không có id số', () => {
  for (const t of ['hello', 'caught_up', 'pong', 'acked', 'error', 'reconnect']) assert.ok(isSystemFrame({ type: t, id: 5 }));
  assert.ok(isSystemFrame({ type: 'assigned' }));
  assert.ok(isSystemFrame({ type: 'assigned', id: '5' }));
  assert.ok(!isSystemFrame({ type: 'assigned', id: 5 }));
  assert.ok(!isSystemFrame({ type: 'loai_la_moi', id: 5 })); // type lạ có id ⇒ vẫn là tin (coi thường)
});

test('dedupe: id ≤ con trỏ hoặc đã gặp ⇒ trùng; con trỏ chỉ tăng', () => {
  const d = dedupe(10);
  assert.ok(d.isDup(10) && d.isDup(3));
  assert.ok(!d.isDup(11));
  d.mark(11); assert.ok(d.isDup(11)); assert.equal(d.cursor, 11);
  d.mark(5); assert.equal(d.cursor, 11);
  d.cursor = 4; assert.equal(d.cursor, 11);
  d.cursor = 20; assert.equal(d.cursor, 20);
  const n = dedupe(null); assert.ok(!n.isDup(0)); n.mark(0); assert.ok(n.isDup(0));
});

test('eventToItem: khung ⇒ tin hộp thư cho bộ lọc (copy ⇒ state copy, from.character_id)', () => {
  const it = eventToItem({ type: 'assigned', id: 4411, at: '2026-10-06T15:37:52Z', task: '1#861', kind: 'assign', text: 'x', from: { character_id: 901, user_id: 2 }, copy: false, prio: 'urgent', to: { id: 1001 } });
  assert.deepEqual([it.id, it.kind, it.task, it.from_character_id, it.state, it.prio, it.to_id], [4411, 'assign', '1#861', 901, null, 'urgent', 1001]);
  assert.equal(eventToItem({ type: 'mention', id: 1, copy: true }).state, 'copy');
  assert.equal(eventToItem({ type: 'tuong_lai', id: 1 }).kind, 'tuong_lai'); // thiếu kind ⇒ lấy type
});

test('closePolicy / httpPolicy', () => {
  assert.deepEqual(closePolicy(4001), { retry: true, backoff: false });
  assert.deepEqual(closePolicy(4002), { retry: false, backoff: false });
  assert.deepEqual(closePolicy(1011), { retry: true, backoff: true });
  assert.deepEqual(closePolicy(0), { retry: true, backoff: true });
  for (const s of [400, 401, 403, 404]) assert.equal(httpPolicy(s).retry, false);
  for (const s of [429, 500, 503]) assert.equal(httpPolicy(s).retry, true);
});
