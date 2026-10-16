import './helpers/hermetic.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyManifests, normalizeConfig } from '../lib/agentd/config.mjs';

const mk = () => { const d = mkdtempSync(join(tmpdir(), 'mf-')); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'NV1.json'), JSON.stringify({ staff_id: 1401, name: 'NV1', role_key: 'NV1', rules_version: 'r1', runtime: { kind: 'headless-cli', cwd: 'D:/x', model: 'claude-sonnet-5-5' } })); return d; };

test('#1045 đổi tài khoản/phiên trong agentd.json ⇒ danh tính NV1 giữ nguyên', () => {
  const dir = mk();
  const a = normalizeConfig({ staff: { NV1: { adapter: 'claude-cli', config_dir: 'C:/max1' } } }).config;
  const b = normalizeConfig({ staff: { NV1: { adapter: 'claude-cli', config_dir: 'C:/max2', session: 'local_zzz' } } }).config;
  assert.deepEqual(applyManifests(a, dir), []); assert.deepEqual(applyManifests(b, dir), []);
  assert.deepEqual(a.staff.NV1.identity, b.staff.NV1.identity);
  assert.equal(a.staff.NV1.identity.staff_id, 1401);
  assert.equal(a.staff.NV1.cwd, 'D:/x'); assert.equal(a.staff.NV1.model, 'claude-sonnet-5-5');
});
test('#1045 NV thiếu manifest ⇒ báo lỗi, không đoán; cwd đặt tay thắng manifest; không có thư mục ⇒ bỏ qua', () => {
  const dir = mk();
  const c = normalizeConfig({ staff: { NV9: { adapter: 'claude-cli' }, NV1: { adapter: 'claude-cli', cwd: 'E:/y' } } }).config;
  const errs = applyManifests(c, dir);
  assert.equal(errs.length, 1); assert.match(errs[0], /NV9/); assert.equal(c.staff.NV1.cwd, 'E:/y');
  assert.deepEqual(applyManifests(c, join(dir, 'khong-co')), []);
});
