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

test('#1079 patrol: mỗi nhịp ghi 1 dòng log tóm tắt (kể cả 0) + status.patrol', async () => {
  const h0 = mkPatrolDaemon({ tasks: [] });
  await h0.d.start(); await h0.d.patrol();
  assert.ok(h0.logs.some((l) => /^tuần tra: kiểm 0 thẻ · claim 0 · kẹt 0 · điếc 0$/.test(l)));
  const s0 = h0.d.writeStatus(); assert.equal(s0.patrol.checked, 0); assert.ok(s0.patrol.last_at); h0.d.stop();
  const h = mkPatrolDaemon({ tasks: [pt(6, 1, 15)] });
  await h.d.start(); await h.d.patrol();
  assert.ok(h.logs.some((l) => /^tuần tra: kiểm 1 thẻ · claim 1 · kẹt 0 · điếc 0$/.test(l)));
  const s = h.d.writeStatus(); assert.deepEqual(s.patrol.actions, { claim: 1, rescue: 0, stuck: 0, deaf: 0 }); h.d.stop();
});

// ---- #1084: tuần tra bỏ qua thẻ chờ PM/chủ
test('#1084 Đang làm có blocked_reason / work_state blocked|waiting|owner_hold ⇒ KHÔNG tiếp quản; thẻ thường vẫn rescue', () => {
  assert.equal(plan([task(1, 2, 30, { blocked_reason: 'needs_review' })]).length, 0);
  assert.equal(plan([task(1, 2, 30, { work_state: { blocked: 'pm', waiting: 'chờ PM' } })]).length, 0);
  assert.equal(plan([task(1, 2, 30, { work_state: { waiting: 'x' } })]).length, 0);
  assert.equal(plan([task(1, 2, 30, { work_state: { owner_hold: { kind: 'owner', waiting: 'x' } } })]).length, 0);
  assert.equal(plan([task(1, 2, 30, { work_state: { stage: 'code' } })]).map((x) => x.kind).join(), 'rescue');
});

// ---- #1128: việc lịch / tuần tra có TRẦN — một await không bao giờ xong không được làm im mọi nhịp sau
import { createScheduler, maxSecondsOf, withDeadline } from '../lib/agentd/schedule.mjs';
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#1128 withDeadline: xong trong trần ⇒ giá trị; treo ⇒ onHang + {hung}; lỗi muộn ⇒ onLateError', async () => {
  assert.equal(await withDeadline(async () => 7, 200, () => assert.fail('không được gọi')), 7);
  let hang = 0; assert.deepEqual(await withDeadline(never, 30, () => hang++), { hung: true }); assert.equal(hang, 1);
  await assert.rejects(withDeadline(async () => { throw new Error('x'); }, 200, () => {}), /x/);
  const late = []; await withDeadline(() => sleep(60).then(() => { throw new Error('muộn'); }), 20, () => {}, (e) => late.push(e.message));
  await sleep(80); assert.deepEqual(late, ['muộn']);
});

test('#1128 trần mặc định + ghi đè defaults.schedule_max_s', () => {
  assert.equal(maxSecondsOf('patrol'), 240); assert.equal(maxSecondsOf('status'), 60);
  assert.equal(maxSecondsOf('patrol', { defaults: { schedule_max_s: { patrol: 30 } } }), 30);
  assert.equal(maxSecondsOf('patrol', { defaults: { schedule_max_s: { patrol: 'x' } } }), 240);
});

test('#1128 lịch protect: lượt treo quá trần ⇒ log 🔴 + nhịp sau VẪN chạy (tái hiện patrol im 37\')', async () => {
  const logs = []; let calls = 0;
  const s = createScheduler({ log: (m) => logs.push(m), maxMs: () => 300 });
  s.set('patrol', '* * * * * *', () => { calls++; return never(); }); // mỗi giây, fn KHÔNG BAO GIỜ resolve (client giả treo)
  await sleep(3_400); s.stop();
  assert.ok(calls >= 2, `nhịp sau phải chạy dù lượt trước treo (gọi ${calls} lần)`);
  assert.ok(logs.some((l) => /🔴 lịch patrol treo >0s|🔴 lịch patrol treo >\d+s/.test(l)), logs.join('\n'));
  assert.ok(s.hung().patrol >= 2);
});

test('#1128 lịch: lượt treo xong muộn ⇒ bớt đếm treo', async () => {
  const logs = []; let first = true;
  const s = createScheduler({ log: (m) => logs.push(m), maxMs: () => 200 });
  s.set('sweep', '* * * * * *', () => { if (first) { first = false; return sleep(600); } return undefined; });
  await sleep(2_300); s.stop();
  assert.equal(s.hung().sweep, undefined, JSON.stringify(s.hung())); assert.ok(logs.some((l) => /lượt treo đã xong muộn/.test(l)));
});

const mkHangDaemon = ({ hangStaff, wake }) => {
  const logs = []; let clock = Date.parse('2026-10-17T10:00:00Z'); const checked = [];
  const { config } = normalizeConfig({ staff: { H1: { adapter: 'fake-spawn' }, H2: { adapter: 'fake-spawn' } }, defaults: { coalesce_ms: 0, patrol_staff_max_s: 0.2, wake_gate_max_s: 60 } });
  const d = createDaemon({
    loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: (m) => logs.push(m), now: () => clock,
    makeClient: (n) => ({ init: async () => '77', tb: (a) => { if (n === hangStaff) return never(); checked.push(n); return Promise.resolve({ data: { tasks: [], columns: [] } }); }, ai: async () => ({ items: [] }), call: async () => ({}) }),
    getAdapter: () => ({ name: 'fake-spawn', spawns: true, isBlank: () => false, activeAgoMs: () => null, wake: wake ?? (async () => ({ ok: true, detail: 'ok' })) }),
    stream: () => ({ state: { connected: true, channel: 'open' }, queue: [], done: new Promise(() => {}), stop() {} }),
  });
  return { d, logs, checked, tick: (ms) => { clock += ms; } };
};

test('#1128 patrol: client giả của MỘT NV treo ⇒ NV kia vẫn được kiểm, vòng vẫn ghi "tuần tra:", NV treo vào backoff', async () => {
  const h = mkHangDaemon({ hangStaff: 'H1' });
  await h.d.start();
  const t0 = Date.now(); await h.d.patrol(); const took = Date.now() - t0;
  assert.ok(took < 2_000, `patrol phải xong trong trần (mất ${took}ms)`);
  assert.deepEqual(h.checked, ['H2']);
  assert.ok(h.logs.some((l) => /🔴 H1: tuần tra lỗi \(lần 1\) — treo >0s/.test(l)), h.logs.join('\n'));
  assert.ok(h.logs.some((l) => /^tuần tra: kiểm/.test(l)));
  h.d.stop();
});

test('#1128 wakeNow: lượt chuẩn bị treo ⇒ HOÃN trong trần, quá wake_gate_max_s ⇒ nhả cổng (không khoá NV vĩnh viễn)', async () => {
  let wakes = 0; const h = mkHangDaemon({ wake: () => { wakes++; return never(); } });
  await h.d.load();
  h.d.wakeNow('H1', 'x'); await sleep(10); assert.equal(wakes, 1);
  const held = await h.d.wakeNow('H1', 'x'); assert.equal(held.hold, true); assert.match(held.detail, /đang có lượt thức/);
  h.tick(61_000); h.d.wakeNow('H1', 'x'); await sleep(10);
  assert.equal(wakes, 2, 'quá trần cổng ⇒ được thức lại');
  assert.ok(h.logs.some((l) => /🔴 H1: lượt thức trước treo >60s.*nhả cổng/.test(l)), h.logs.join('\n'));
  h.d.stop();
});

test('#1128 patrol: NV có cổng thức kẹt quá wake_gate_max_s ⇒ tuần tra tự nhả cổng rồi kiểm (không bỏ qua mãi)', async () => {
  const h = mkHangDaemon({});
  await h.d.start(); h.checked.length = 0;
  Object.assign(h.d.st.get('H1') ?? (h.d.st.set('H1', { wakes: 0, failures: 0, retryAt: 0 }), h.d.st.get('H1')), { waking: true, wakingSince: Date.parse('2026-10-17T10:00:00Z') });
  await h.d.patrol(); assert.deepEqual(h.checked, ['H2'], 'cổng còn trong trần ⇒ bỏ qua H1');
  h.tick(61_000); h.checked.length = 0; await h.d.patrol();
  assert.deepEqual(h.checked.sort(), ['H1', 'H2']); assert.ok(h.logs.some((l) => /🔴 H1: lượt thức trước treo.*nhả cổng/.test(l)));
  h.d.stop();
});

test('#1128 patrol: lượt NV treo chạy tiếp MUỘN ⇒ không xoá backoff, không hành động theo dữ liệu cũ', async () => {
  let release; let h1Calls = 0; const logs = []; let clock = Date.parse('2026-10-17T10:00:00Z');
  const { config } = normalizeConfig({ staff: { H1: { adapter: 'fake-spawn' } }, defaults: { coalesce_ms: 0, patrol_staff_max_s: 0.1 } });
  const woken = [];
  const d = createDaemon({
    loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: (m) => logs.push(m), now: () => clock,
    makeClient: () => ({ init: async () => '77', tb: (a) => { if (a !== 'get') return Promise.resolve({}); h1Calls++; return h1Calls === 1 ? new Promise((r) => { release = r; }) : Promise.resolve({ data: { tasks: [], columns: [] } }); }, ai: async () => ({ items: [] }), call: async () => ({}) }),
    getAdapter: () => ({ name: 'fake-spawn', spawns: true, isBlank: () => false, activeAgoMs: () => null, wake: async (ctx) => { woken.push(ctx.prompt); return { ok: true, detail: 'ok' }; } }),
    stream: () => ({ state: { connected: true, channel: 'open' }, queue: [], done: new Promise(() => {}), stop() {} }),
  });
  await d.start(); await d.patrol(); assert.equal(h1Calls, 1);
  assert.ok(logs.some((l) => /H1: tuần tra lỗi \(lần 1\).*30s/.test(l)));
  release({ data: { tasks: [{ id: 6, column_id: 1, title: 't', priority: 'normal', labels: ['@H1'], entered_column_at: ago(60) }], columns: [{ id: 1, name: 'Đã giao' }, { id: 2, name: 'Đang làm' }] } });
  await sleep(20);
  assert.equal(woken.length, 0, 'lượt muộn không được mở lượt');
  clock += 10_000; await d.patrol(); assert.equal(h1Calls, 1, 'backoff 30s còn nguyên sau khi lượt treo xong muộn');
  d.stop();
});
