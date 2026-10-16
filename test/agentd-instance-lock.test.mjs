import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireInstanceLock, releaseInstanceLock } from '../lib/agentd/instance-lock.mjs';

const file = () => join(mkdtempSync(join(tmpdir(), 'agentd-lock-')), 'agentd.lock');

test('khoá trống ⇒ giữ được; bản thứ hai (pid khác còn sống) bị từ chối', () => {
  const f = file();
  assert.equal(acquireInstanceLock({ self: 100, file: f, alive: () => true }).ok, true);
  const r = acquireInstanceLock({ self: 200, file: f, alive: () => true });
  assert.deepEqual(r, { ok: false, owner: 100 });
});

test('chủ khoá đã chết ⇒ bản mới tiếp quản', () => {
  const f = file();
  acquireInstanceLock({ self: 100, file: f, alive: () => true });
  assert.equal(acquireInstanceLock({ self: 200, file: f, alive: (p) => p !== 100 }).ok, true);
  assert.equal(readFileSync(f, 'utf8'), '200');
});

test('daemon bản cũ không biết khoá nhưng status tươi ⇒ từ chối; status cũ ⇒ cho qua', () => {
  const f = file(); const now = 1_000_000;
  assert.deepEqual(acquireInstanceLock({ self: 200, file: f, now, alive: () => true, statusRead: () => ({ pid: 100, beat: now - 10_000 }) }), { ok: false, owner: 100 });
  assert.equal(acquireInstanceLock({ self: 200, file: f, now, alive: () => true, statusRead: () => ({ pid: 100, beat: now - 200_000 }) }).ok, true);
});

test('release chỉ xoá khoá của chính mình', () => {
  const f = file();
  acquireInstanceLock({ self: 100, file: f, alive: () => true });
  releaseInstanceLock({ self: 999, file: f });
  assert.equal(readFileSync(f, 'utf8'), '100');
  releaseInstanceLock({ self: 100, file: f });
  assert.equal(acquireInstanceLock({ self: 300, file: f, alive: () => true }).ok, true);
});
