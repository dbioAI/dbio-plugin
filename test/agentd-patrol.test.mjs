import './helpers/hermetic.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PATROL_DEFAULTS, backoffMs, deafVerdict, idleVerdict, patrolCfg, planCards, rootsOnly } from '../lib/agentd/patrol.mjs';
import { claudeNamed, reconcileProcs } from '../lib/agentd/procs.mjs';
import { resolveSchedule } from '../lib/agentd/schedule.mjs';

const cols = [{ id: 1, name: 'Đã giao' }, { id: 2, name: 'Đang làm' }];
const T0 = Date.parse('2026-10-16T10:00:00Z'); const min = (m) => T0 + m * 60_000;
const task = (id, column_id, minsAgo, over = {}) => ({ id, column_id, title: 't', priority: 'normal', labels: ['@NV1'], entered_column_at: new Date(T0 - minsAgo * 60_000).toISOString(), ...over });
const plan = (tasks, openCards = new Set(), p) => planCards({ board: 5, tasks, columns: cols, name: 'NV1', openCards, now: T0, p });

test('backoff 30s → 5\' trần', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n) / 1000), [30, 60, 120, 240, 300, 300]);
});
test('patrolCfg: ghi đè từ defaults, rác bị bỏ', () => {
  assert.equal(patrolCfg({ defaults: { patrol_claim_min: 3, patrol_idle_kill_min: 'x' } }).patrol_claim_min, 3);
  assert.equal(patrolCfg({ defaults: { patrol_idle_kill_min: 'x' } }).patrol_idle_kill_min, PATROL_DEFAULTS.patrol_idle_kill_min);
});
test('Đã giao >10\' không Run ⇒ claim; <10\' ⇒ chờ', () => {
  assert.deepEqual(plan([task(1, 1, 11)]).map((x) => [x.card, x.kind]), [['5#1', 'claim']]);
  assert.deepEqual(plan([task(1, 1, 9)]), []);
});
test('Đang làm không Run mở ⇒ rescue; có Run mở ⇒ im', () => {
  assert.deepEqual(plan([task(2, 2, 1)]).map((x) => x.kind), ['rescue']);
  assert.deepEqual(plan([task(2, 2, 1)], new Set(['5#2'])), []);
});
test('đang làm dở hoặc có Run mở thẻ khác ⇒ KHÔNG claim thẻ Đã giao (mỗi NV một thẻ)', () => {
  assert.deepEqual(plan([task(1, 1, 60), task(2, 2, 1)], new Set(['5#2'])), []);
  assert.deepEqual(plan([task(1, 1, 60)], new Set(['5#9'])), []);
});
test('thẻ nhãn người khác / đã xoá ⇒ bỏ', () => {
  assert.deepEqual(plan([task(1, 1, 60, { labels: ['@NV2'] }), task(3, 1, 60, { deleted_at: 'x' })]), []);
});
test('idleVerdict: ok/warn/kill, không biết ⇒ ok', () => {
  const v = (m) => idleVerdict({ lastActAt: T0, now: min(m) });
  assert.deepEqual([v(5), v(10), v(19), v(20)], ['ok', 'warn', 'warn', 'kill']);
  assert.equal(idleVerdict({ lastActAt: null, now: min(99) }), 'ok');
});
test('deafVerdict: đóng 4002 >10\' ⇒ deaf; kênh mở/chưa đủ 10\' ⇒ ok', () => {
  assert.equal(deafVerdict({ channel: 'closed_4002', channelSince: T0, now: min(11) }), 'deaf');
  assert.equal(deafVerdict({ channel: 'closed_4002', channelSince: T0, now: min(9) }), 'ok');
  assert.equal(deafVerdict({ channel: 'open', channelSince: T0, now: min(99) }), 'ok');
});
test('đếm tiến trình: shim cmd.exe/node có --name không tính — 8 tiến trình, 2 lượt', () => {
  const procs = [
    { pid: 10, ppid: 1, cmd: 'cmd.exe /c claude -p x --name NV1' }, { pid: 11, ppid: 10, cmd: 'C:/p/claude.exe -p x --name NV1' },
    { pid: 12, ppid: 1, cmd: 'node C:/p/cli.js -p x --name NV2' }, { pid: 13, ppid: 12, cmd: 'claude.exe -p x --name NV2' },
    { pid: 14, ppid: 1, cmd: 'claude.exe --name pinned' },
  ];
  assert.deepEqual(claudeNamed(procs).map((x) => x.pid), [11, 13]);
  assert.deepEqual(rootsOnly(claudeNamed(procs)).map((x) => x.pid), [11, 13]);
  const r = reconcileProcs(procs, [{ pid: 11 }, { pid: 13 }], () => true); assert.equal(r.mismatch, false); assert.equal(r.named, 2);
});
test('lịch: patrol 5\' có mặc định, tắt được', () => {
  assert.equal(resolveSchedule({}).cron.patrol, '0 */5 * * * *');
  assert.equal(resolveSchedule({ schedule: { patrol: false } }).cron.patrol, false);
});

// ── tích hợp daemon.patrol với deps giả (#1079) ──
import { createDaemon } from '../lib/agentd/daemon.mjs';
import { normalizeConfig } from '../lib/agentd/config.mjs';

const mkPatrolDaemon = ({ tasks, failTb = false }) => {
  const logs = []; const woken = []; let clock = Date.parse('2026-10-17T10:00:00Z'); let tbCalls = 0;
  const { config } = normalizeConfig({ staff: { PT1: { adapter: 'fake-spawn' } }, defaults: { coalesce_ms: 0 } });
  const d = createDaemon({
    loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: (m) => logs.push(m), now: () => clock,
    makeClient: () => ({ init: async () => '77', tb: async () => { tbCalls++; if (failTb) throw new Error('fetch failed'); return { data: { tasks, columns: [{ id: 1, name: 'Đã giao' }, { id: 2, name: 'Đang làm' }] } }; }, ai: async () => ({ items: [] }), call: async () => ({}) }),
    getAdapter: () => ({ name: 'fake-spawn', spawns: true, isBlank: () => false, activeAgoMs: () => null, wake: async (ctx) => { woken.push(ctx.prompt); return { ok: true, detail: 'ok' }; } }),
    stream: () => ({ state: { connected: true, channel: 'open' }, queue: [], done: new Promise(() => {}), stop() {} }),
  });
  return { d, logs, woken, tick: (ms) => { clock += ms; }, tbCalls: () => tbCalls };
};

test('#1079 patrol: lỗi mạng ⇒ log đỏ + backoff (không quét lại trong hạn)', async () => {
  const h = mkPatrolDaemon({ tasks: [], failTb: true });
  await h.d.start(); await h.d.patrol(); await h.d.patrol();
  assert.equal(h.tbCalls(), 1, 'trong hạn backoff không gọi lại');
  assert.ok(h.logs.some((l) => /tuần tra lỗi \(lần 1\).*30s/.test(l)));
  h.tick(31_000); await h.d.patrol();
  assert.equal(h.tbCalls(), 2); assert.ok(h.logs.some((l) => /lần 2.*60s/.test(l)));
  h.d.stop();
});

const ago = (m) => new Date(Date.parse('2026-10-17T10:00:00Z') - m * 60_000).toISOString();
const pt = (id, col, m) => ({ id, column_id: col, title: 't', priority: 'normal', labels: ['@PT1'], entered_column_at: ago(m) });

test('#1079 patrol: Đã giao >10\' không Run ⇒ tự mở lượt (claim); <10\' thì chưa', async () => {
  const young = mkPatrolDaemon({ tasks: [pt(5, 1, 4)] });
  await young.d.start(); await young.d.patrol(); await new Promise((r) => setTimeout(r, 50));
  assert.equal(young.woken.length, 0); young.d.stop();
  const h = mkPatrolDaemon({ tasks: [pt(6, 1, 15)] });
  await h.d.start(); await h.d.patrol();
  assert.equal(h.woken.length, 1); assert.match(h.woken[0], /77#6/); assert.match(h.woken[0], /chưa ai nhận/);
  await h.d.patrol(); assert.equal(h.woken.length, 1, 'không mở trùng trong 10\''); h.d.stop();
});

test('#1079 patrol: Đang làm không Run ⇒ tiếp quản (rescue)', async () => {
  const h = mkPatrolDaemon({ tasks: [pt(9, 2, 70)] });
  await h.d.start(); await h.d.patrol();
  assert.equal(h.woken.length, 1); assert.match(h.woken[0], /77#9/); assert.match(h.woken[0], /không phiên nào làm/); h.d.stop();
});
