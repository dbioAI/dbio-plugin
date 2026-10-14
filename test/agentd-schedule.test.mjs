import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, resolveSchedule, everyMinCron, DEFAULT_SCHEDULE } from '../lib/agentd/schedule.mjs';

test('every_min ⇒ cron; mặc định đủ việc', () => {
  assert.equal(everyMinCron(10), '0 */10 * * * *'); assert.equal(everyMinCron(120), '0 0 */2 * * *'); assert.equal(everyMinCron(0), false);
  const r = resolveSchedule({ discover: { every_min: 10 }, rules: { sweep: { every_min: 15 }, hygiene: { every_min: 0 } } });
  assert.equal(r.cron.discover, '0 */10 * * * *'); assert.equal(r.cron.sweep, '0 */15 * * * *'); assert.equal(r.cron.hygiene, false);
  assert.equal(r.cron.runs_reconcile, DEFAULT_SCHEDULE.runs_reconcile); assert.deepEqual(r.errors, []);
});

test('schedule trong cấu hình: ghi đè, tắt bằng false, biểu thức hỏng ⇒ lỗi + mặc định, tên lạ ⇒ lỗi', () => {
  const r = resolveSchedule({ schedule: { reconcile: '0 */2 * * * *', sweep: false, runs_beat: 'không phải cron', lạ: '* * * * *' } });
  assert.equal(r.cron.reconcile, '0 */2 * * * *'); assert.equal(r.cron.sweep, false); assert.equal(r.cron.runs_beat, DEFAULT_SCHEDULE.runs_beat);
  assert.equal(r.errors.length, 2); assert.match(r.errors.join('\n'), /runs_beat.*hỏng/); assert.match(r.errors.join('\n'), /lạ/);
});

test('scheduler: chạy đúng lịch, lỗi không làm vỡ, không chồng lượt, set lại/tắt', async () => {
  const logs = []; const s = createScheduler({ log: (m) => logs.push(m) });
  let n = 0; let boom = 0; let overlap = 0; let running = 0;
  s.set('a', '* * * * * *', () => { n++; });
  s.set('b', '* * * * * *', () => { boom++; throw new Error('hỏng'); });
  s.set('c', '* * * * * *', async () => { running++; overlap = Math.max(overlap, running); await new Promise((r) => setTimeout(r, 1500)); running--; });
  assert.equal(s.set('off', false, () => {}), false);
  await new Promise((r) => setTimeout(r, 2600));
  assert.ok(n >= 2); assert.ok(boom >= 2); assert.equal(overlap, 1); assert.ok(logs.some((m) => /lịch b: hỏng/.test(m)));
  s.set('a', false, () => {}); const before = n; await new Promise((r) => setTimeout(r, 1300)); assert.equal(n, before);
  s.stop(); assert.deepEqual(s.names(), []);
});
