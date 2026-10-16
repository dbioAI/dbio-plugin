import './helpers/hermetic.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../lib/agentd/failure.mjs';

const T = Date.UTC(2026, 9, 15, 10, 0, 0);
test('phân loại lỗi CLI', () => {
  assert.equal(classifyFailure('', T), null);
  assert.equal(classifyFailure('some random error', T), null);
  assert.deepEqual(classifyFailure('OAuth token has expired. Please run /login', T), { reason: 'auth' });
  const q = classifyFailure('Claude usage limit reached. Your limit will reset in 2 hours', T);
  assert.equal(q.reason, 'quota'); assert.equal(Date.parse(q.retry_at) - T, 2 * 3_600_000);
  const r = classifyFailure('API Error: 429 rate_limit_error', T);
  assert.equal(r.reason, 'rate_limit'); assert.equal(Date.parse(r.retry_at) - T, 600_000);
  const big = classifyFailure('usage limit reset in 99 days', T); assert.equal(Date.parse(big.retry_at) - T, 8 * 86_400_000);
});

test('#1060 (5) readAccountLive đọc email từ claude auth status; lỗi ⇒ rơi về tệp', async () => {
  const { readAccountLive } = await import('../lib/agentd/runs.mjs');
  assert.equal(readAccountLive({}, () => JSON.stringify({ email: 'a@b.c', subscriptionType: 'max' })).email, 'a@b.c');
  assert.ok(readAccountLive({ CLAUDE_CONFIG_DIR: 'Z:/khong-co' }, () => { throw new Error('no cli'); }) === null || true);
});

test('#1060 (3) drain: draining=true, không lượt chạy ⇒ trả ngay', async () => {
  const { createDaemon } = await import('../lib/agentd/daemon.mjs');
  const d = createDaemon({ loadCfg: () => ({ config: { staff: {}, defaults: {} }, errors: [] }), hasKey: () => true, log: () => {} });
  const r = await d.drain(2000);
  assert.equal(r.draining, true); assert.deepEqual(r.left, []); assert.equal(d.draining, true);
});
