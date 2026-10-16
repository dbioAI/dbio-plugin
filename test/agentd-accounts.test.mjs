import './helpers/hermetic.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccounts, pickAccount } from '../lib/agentd/accounts.mjs';

const T = Date.UTC(2026, 9, 15, 10);
const accs = normalizeAccounts([{ label: 'max1', config_dir: '/c1', reserved_for_owner: true }, { label: 'max2', config_dir: '/c2' }, { label: 'max3', config_dir: '/c3' }, { label: '', config_dir: 'x' }]);
test('chuẩn hoá bỏ mục thiếu nhãn', () => assert.equal(accs.length, 3));
test('Max 1 reserved chỉ khi các tài khoản kia hoãn; luân phiên; không spawn trước retry_at', () => {
  const st = {}; const seq = [];
  for (let i = 0; i < 10; i++) { const p = pickAccount(accs, st, T + i); seq.push(p.account.label); st[p.account.label] = { last_used_at: T + i }; }
  assert.deepEqual(seq, ['max2', 'max3', 'max2', 'max3', 'max2', 'max3', 'max2', 'max3', 'max2', 'max3']);
  const q = { max2: { reason: 'quota', retry_at: new Date(T + 3600_000).toISOString() }, max3: { reason: 'rate_limit', retry_at: new Date(T + 600_000).toISOString() } };
  assert.equal(pickAccount(accs, q, T).account.label, 'max1');
  q.max1 = { reason: 'auth' };
  assert.match(pickAccount(accs, q, T).hold, /max1: cần đăng nhập.*max2: hết quota/);
  assert.equal(pickAccount(accs, q, T + 700_000).account.label, 'max3');
  assert.equal(pickAccount(accs, q, T + 4000_000).account.label, 'max2');
});
