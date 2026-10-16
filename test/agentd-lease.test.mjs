import './helpers/hermetic.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeases } from '../lib/agentd/lease.mjs';

const mk = () => { const clock = { t: 1_000_000 }; const L = createLeases({ dir: mkdtempSync(join(tmpdir(), 'lease-')), now: () => clock.t }); return { L, clock }; };

test('lease: một chủ tại một thời điểm, người sau bị từ chối kèm thời gian còn lại', () => {
  const { L } = mk();
  const a = L.acquire('browser', { holder: 'NV1', ttl_s: 60 });
  assert.equal(a.ok, true); assert.equal(a.gen, 1);
  const b = L.acquire('browser', { holder: 'NV2', ttl_s: 60 });
  assert.equal(b.ok, false); assert.equal(b.holder, 'NV1'); assert.equal(b.remaining_s, 60);
  assert.equal(L.status('browser').held, true);
});

test('lease: chủ xin lại = gia hạn cùng gen; hết hạn ⇒ người sau chiếm, gen+1, chủ cũ gia hạn bị LEASE_LOST', () => {
  const { L, clock } = mk();
  const a = L.acquire('browser', { holder: 'NV1', ttl_s: 60 });
  clock.t += 30_000;
  assert.equal(L.acquire('browser', { holder: 'NV1', ttl_s: 60 }).gen, a.gen);
  assert.equal(L.renew('browser', { holder: 'NV1', gen: a.gen, ttl_s: 60 }).ok, true);
  clock.t += 61_000;
  assert.equal(L.status('browser').held, false);
  const b = L.acquire('browser', { holder: 'NV2', ttl_s: 60 });
  assert.equal(b.ok, true); assert.equal(b.gen, a.gen + 1); assert.equal(b.takeover, true);
  const late = L.renew('browser', { holder: 'NV1', gen: a.gen });
  assert.equal(late.ok, false); assert.equal(late.lost, true);
  assert.equal(L.release('browser', { holder: 'NV1', gen: a.gen }).released, false);
  assert.equal(L.status('browser').holder, 'NV2');
});

test('lease: nhả giữ bia mộ ⇒ gen không tụt; nhả sai chủ/sai gen không làm gì', () => {
  const { L } = mk();
  const a = L.acquire('browser', { holder: 'NV1' });
  assert.equal(L.release('browser', { holder: 'NV2' }).released, false);
  assert.equal(L.release('browser', { holder: 'NV1', gen: 99 }).released, false);
  assert.equal(L.release('browser', { holder: 'NV1', gen: a.gen }).released, true);
  assert.equal(L.status('browser').held, false);
  assert.equal(L.acquire('browser', { holder: 'NV2' }).gen, a.gen + 1);
});

test('lease: pid chủ đã mất ⇒ coi như hết hạn (chiếm được ngay)', () => {
  const { L } = mk();
  L.acquire('browser', { holder: 'NV1', pid: 2_147_000_000, ttl_s: 600 });
  assert.equal(L.status('browser').held, false);
  assert.equal(L.acquire('browser', { holder: 'NV2' }).ok, true);
});

test('lease: tên tài nguyên lạ bị chặn; releaseIf nhả theo điều kiện; all() liệt kê', () => {
  const { L } = mk();
  assert.throws(() => L.acquire('../x', { holder: 'a' }));
  L.acquire('browser', { holder: 'NV1', run_id: 'r1' });
  assert.equal(L.releaseIf('browser', (c) => c.run_id === 'zzz'), false);
  assert.equal(L.releaseIf('browser', (c) => c.run_id === 'r1'), true);
  assert.equal(L.all()[0].held, false);
});
