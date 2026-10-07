import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeStaleCheck } from '../lib/stale-card.mjs';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const old = new Date(NOW - 3 * 3_600_000).toISOString(); const fresh = new Date(NOW - 60_000).toISOString();
const mk = (fn) => { const calls = []; const c = makeStaleCheck(async (t, a) => { calls.push(a); return fn(a); }, { now: () => NOW, as: 'Qa' }); c.calls = calls; return c; };

test('#872 nợ 4: nhắc CŨ trên thẻ đã Xong ⇒ card-done; thẻ không còn ⇒ card-gone; thẻ đang làm ⇒ giữ', async () => {
  const c = mk((a) => (a.task_id === 1 ? { task: { column: { name: 'Xong' } } } : a.task_id === 2 ? { task: { column: { name: 'Đang làm' } } } : Promise.reject(Object.assign(new Error('từ chối: không tìm thấy thẻ'), { code: 'NOT_FOUND' }))));
  assert.equal(await c({ kind: 'mention', task: '9#1', at: old }), 'card-done');
  assert.equal(await c({ kind: 'mention', task: '9#2', at: old }), null);
  assert.equal(await c({ kind: 'owner_reply', task: '9#3', at: old }), 'card-gone');
  assert.equal(c.calls[0].as, 'Qa'); assert.equal(c.calls[0].profile_id, 9);
});
test('#872 nợ 4: tin MỚI, giao việc (assign), không gắn thẻ, lỗi mạng ⇒ KHÔNG bao giờ coi là rác; kết quả nhớ theo thẻ', async () => {
  const done = mk(() => ({ task: { column: { name: 'Xong' } } }));
  assert.equal(await done({ kind: 'mention', task: '9#1', at: fresh }), null, 'tin mới (mở lại thẻ) vẫn thức');
  assert.equal(await done({ kind: 'assign', task: '9#1', at: old }), null);
  assert.equal(await done({ kind: 'mention', task: null, at: old }), null);
  assert.equal(done.calls.length, 0);
  assert.equal(await done({ kind: 'mention', task: '9#1', at: old }), 'card-done'); assert.equal(await done({ kind: 'nudge', task: '9#1', at: old }), 'card-done');
  assert.equal(done.calls.length, 1, 'nhớ theo thẻ');
  const net = mk(() => Promise.reject(new Error('HTTP 500')));
  assert.equal(await net({ kind: 'mention', task: '9#4', at: old }), null);
});
