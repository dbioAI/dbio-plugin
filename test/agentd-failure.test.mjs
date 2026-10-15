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
