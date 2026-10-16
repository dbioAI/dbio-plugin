import './helpers/hermetic.mjs';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { claudeSpawned } from './helpers/hermetic.mjs';

test('hermetic: homedir/DBIO_HOME là thư mục tạm, không phải ~ thật; không khoá thật trong env', () => {
  assert.notEqual(process.env.DBIO_HOME, process.env.DBIO_REAL_HOME);
  assert.notEqual(homedir(), process.env.DBIO_REAL_HOME);
  assert.match(homedir(), /dbio-hermetic-/);
  assert.equal(process.env.DBIO_MACHINE_KEY, undefined);
  assert.notEqual('claude', process.env.DBIO_AGENT_BIN ?? 'x');
});

test('không có claude.exe sinh ra khi chạy bộ test (claude giả đứng đầu PATH không bị gọi)', () => {
  assert.equal(claudeSpawned(), false, 'có test gọi `claude` thật/theo tên — dùng bin giả (node script) + DBIO_HOME tạm');
});
