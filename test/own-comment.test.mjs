import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeOwnCommentCheck } from '../lib/own-comment.mjs';

const list = [{ id: 10, author_staff_id: 901 }, { id: 11, author_staff_id: 1401 }];
const mk = (fn) => { const calls = []; const c = makeOwnCommentCheck(async (t, a) => { calls.push(a); return fn(a); }, { as: 'PM' }); c.calls = calls; return c; };

test('#872 R3: @nhắc/bản sao có ref_id = bình luận do CHÍNH MÌNH viết (author_staff_id = self) ⇒ self-comment; của người khác ⇒ giữ', async () => {
  const c = mk(() => ({ comments: list }));
  assert.equal(await c({ kind: 'mention', task: '5#7', ref_id: 10 }, 901), 'self-comment');
  assert.equal(await c({ kind: 'mention', task: '5#7', ref_id: 11 }, 901), null);
  assert.equal(c.calls[0].profile_id, 5); assert.equal(c.calls[0].task_id, 7); assert.equal(c.calls[0].as, 'PM');
});
test('#872 R3: không tra được / thiếu dữ kiện / loại khác ⇒ KHÔNG bao giờ coi là tin tự gửi', async () => {
  const bad = mk(() => Promise.reject(new Error('HTTP 500')));
  assert.equal(await bad({ kind: 'mention', task: '5#7', ref_id: 10 }, 901), null);
  const ok = mk(() => ({ comments: list }));
  assert.equal(await ok({ kind: 'assign', task: '5#7', ref_id: 10 }, 901), null);
  assert.equal(await ok({ kind: 'mention', task: '5#7', ref_id: null }, 901), null);
  assert.equal(await ok({ kind: 'mention', task: '5#7', ref_id: 10 }, null), null);
  assert.equal(await ok({ kind: 'mention', task: null, ref_id: 10 }, 901), null);
  assert.equal(await ok({ kind: 'mention', task: '5#7', ref_id: 99 }, 901), null, 'không có bình luận đó');
  assert.equal(ok.calls.length, 1, 'nhớ 3 giây theo thẻ');
});
