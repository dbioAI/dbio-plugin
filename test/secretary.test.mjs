import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR_MS, formatAction, formatNext, holderOf, lastActivity, markNudged, needsCommentCheck, pickNext, planSweep } from '../lib/secretary.mjs';
import { classify, coalesceGate, filterInbox, shouldWake } from '../lib/watch-filter.mjs';

process.env.DBIO_PM_NAME = 'PM'; // tên trưởng nhóm theo workspace
const NOW = Date.parse('2026-10-03T12:00:00Z');
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const COLS = [{ id: 11, name: 'Nhận' }, { id: 14, name: 'Đã giao' }, { id: 12, name: 'Đang làm' }, { id: 17, name: 'Cần anh xử lý' }, { id: 15, name: 'Chờ duyệt' }, { id: 13, name: 'Xong' }];
const task = (id, col, who, o = {}) => ({ id, column_id: col, title: `thẻ ${id}`, labels: JSON.stringify(who ? ['x', `@${who}`] : ['x']), priority: 'medium', updated_at: at(5), entered_column_at: at(5), ...o });
const st = (name, o = {}) => ({ id: name.length, name, state: 'working', last_seen_at: at(1), runtime: { session_ref: `local_${name}` }, task: null, ...o });

test('holderOf: theo staff.task trước, rồi nhãn @tên (chuẩn hoá khoảng trắng/hoa thường)', () => {
  const staff = [st('DEV A'), st('DEV B', { task: { task_id: 7 } })];
  assert.equal(holderOf({ id: 7, labels: '[]' }, staff).name, 'DEV B');
  assert.equal(holderOf({ id: 8, labels: ['@dev  a'] }, staff).name, 'DEV A');
  assert.equal(holderOf({ id: 9, labels: ['x'] }, staff), null);
});

test('sweep: thẻ vừa có hoạt động ⇒ không có việc nào', () => {
  const r = planSweep({ tasks: [task(1, 12, 'DEV A')], columns: COLS, staff: [st('DEV A')], now: NOW });
  assert.deepEqual(r, []);
});

test('sweep: Đã giao + assigned_unacked ⇒ wake (kèm phiên); lặp lại không trước 10 phút', () => {
  const staff = [st('DEV A', { state: 'assigned_unacked' })];
  const tasks = [task(1, 14, 'DEV A')];
  const r = planSweep({ tasks, columns: COLS, staff, now: NOW });
  assert.equal(r.length, 1); assert.equal(r[0].kind, 'wake'); assert.equal(r[0].session, 'local_DEV A');
  assert.match(formatAction(r[0]), /ĐÁNH THỨC #1 · DEV A → local_DEV A/);
  const n = markNudged({}, r, NOW);
  assert.equal(planSweep({ tasks, columns: COLS, staff, nudged: n, now: NOW + 5 * 60_000 }).length, 0);
  assert.equal(planSweep({ tasks, columns: COLS, staff, nudged: n, now: NOW + 11 * 60_000 }).length, 1);
});

test('sweep: im 60–120 phút ⇒ ask; > 120 ⇒ pm (không cả hai); mỗi loại 1 lần / khung giờ', () => {
  const staff = [st('DEV A')];
  const ask = planSweep({ tasks: [task(1, 12, 'DEV A', { updated_at: at(90), entered_column_at: at(90) })], columns: COLS, staff, now: NOW });
  assert.deepEqual(ask.map((a) => a.kind), ['ask']);
  const pm = planSweep({ tasks: [task(1, 12, 'DEV A', { updated_at: at(150), entered_column_at: at(150) })], columns: COLS, staff, now: NOW });
  assert.deepEqual(pm.map((a) => a.kind), ['pm']); assert.match(pm[0].text, /@PM/);
  const n = markNudged({}, ask, NOW);
  assert.equal(planSweep({ tasks: [task(1, 12, 'DEV A', { updated_at: at(90), entered_column_at: at(90) })], columns: COLS, staff, nudged: n, now: NOW + 10 * 60_000 }).filter((a) => a.kind === 'ask').length, 0);
});

test('sweep: bình luận mới nhất kéo dài mốc im (lastComment)', () => {
  const t = task(1, 12, 'DEV A', { updated_at: at(200), entered_column_at: at(200) });
  assert.equal(planSweep({ tasks: [t], columns: COLS, staff: [st('DEV A')], lastComment: { 1: at(10) }, now: NOW }).length, 0);
  assert.equal(lastActivity(t, at(10)), NOW - 10 * 60_000);
});

test('sweep: cột Cần anh xử lý / Chờ duyệt / Xong không tính là im', () => {
  const old = { updated_at: at(500), entered_column_at: at(500) };
  const r = planSweep({ tasks: [task(1, 17, 'DEV A', old), task(2, 15, 'DEV A', old), task(3, 13, 'DEV A', old)], columns: COLS, staff: [st('DEV A')], now: NOW });
  assert.deepEqual(r, []);
  assert.equal(needsCommentCheck(task(1, 17, 'DEV A', old), COLS, NOW), false);
  assert.equal(needsCommentCheck(task(1, 12, 'DEV A', old), COLS, NOW), true);
  assert.equal(needsCommentCheck(task(1, 12, 'DEV A'), COLS, NOW), false);
});

test('sweep: mất nhịp > 10 phút ở Đang làm ⇒ lost; không phiên ⇒ nosess (không wake/ask)', () => {
  const lost = planSweep({ tasks: [task(1, 12, 'DEV A')], columns: COLS, staff: [st('DEV A', { last_seen_at: at(30) })], now: NOW });
  assert.deepEqual(lost.map((a) => a.kind), ['lost']);
  const ns = planSweep({ tasks: [task(1, 14, 'DEV A', { updated_at: at(300), entered_column_at: at(300) })], columns: COLS, staff: [st('DEV A', { state: 'assigned_unacked', runtime: {} })], now: NOW });
  assert.deepEqual(ns.map((a) => a.kind), ['nosess']);
});

test('sweep: một nhân viên 2 thẻ ⇒ double; thẻ không người cầm bị bỏ qua', () => {
  const r = planSweep({ tasks: [task(1, 12, 'DEV A'), task(2, 14, 'DEV A'), task(3, 12, null)], columns: COLS, staff: [st('DEV A')], now: NOW });
  assert.deepEqual(r.map((a) => a.kind), ['double']); assert.match(r[0].text, /#1, #2/);
});

test('markNudged dọn mục > 6 giờ; HOUR_MS = 60 phút', () => {
  const n = markNudged({ '9:ask': NOW - 7 * HOUR_MS, '8:ask': NOW - HOUR_MS }, [{ task: 1, kind: 'wake' }], NOW);
  assert.deepEqual(Object.keys(n).sort(), ['1:wake', '8:ask']);
});

test('next: Đã giao + nhãn @tôi; ưu tiên cao trước, rồi cũ trước; cảnh báo thẻ đang làm dở', () => {
  const tasks = [
    task(1, 14, 'DEV A', { priority: 'medium', entered_column_at: at(100) }),
    task(2, 14, 'DEV A', { priority: 'high', entered_column_at: at(10) }),
    task(3, 14, 'DEV A', { priority: 'high', entered_column_at: at(50) }),
    task(4, 14, 'DEV B', { priority: 'urgent' }),
    task(5, 12, 'DEV A'),
    task(6, 13, 'DEV A'),
  ];
  const r = pickNext({ tasks, columns: COLS, meName: 'dev a' });
  assert.equal(r.next.id, 3); assert.deepEqual(r.queue.map((t) => t.id), [2, 1]); assert.deepEqual(r.doing.map((t) => t.id), [5]);
  assert.match(formatNext(r), /^#3 \[high\] thẻ 3 · còn 2 thẻ chờ · ⚠️ đang làm dở #5/);
});

test('next: không có thẻ ⇒ "hết việc"; ưu tiên số (0-3) và chuỗi cùng hiểu', () => {
  assert.equal(formatNext(pickNext({ tasks: [task(1, 13, 'DEV A')], columns: COLS, meName: 'DEV A' })), 'hết việc');
  const r = pickNext({ tasks: [task(1, 14, 'DEV A', { priority: 1 }), task(2, 14, 'DEV A', { priority: 3 })], columns: COLS, meName: 'DEV A' });
  assert.equal(r.next.id, 2);
});

test('owner_assign là tin KHẨN; bản sao nhắc/giao việc của thư ký khẩn, gộp coalesce 20s', () => {
  assert.equal(classify({ kind: 'owner_assign', text: '' }), 'urgent');
  const it = { id: 1, kind: 'owner_assign', task: '1001#9', from_user_id: 5, text: 'giao DEV B', at: new Date(NOW).toISOString(), state: 'copy', copy_of: 12 };
  const r = filterInbox([it], { meId: 701, meName: 'THƯ KÝ', secretary: true, now: NOW });
  assert.equal(r.keep[0].cls, 'urgent');
  assert.equal(shouldWake([{ cls: 'urgent', firstSeen: NOW }], NOW).wake, true);
  const g1 = coalesceGate(null, NOW, 20_000);
  assert.deepEqual(g1, { emit: false, pendingSince: NOW });
  assert.equal(coalesceGate(g1.pendingSince, NOW + 10_000, 20_000).emit, false);
  assert.equal(coalesceGate(g1.pendingSince, NOW + 20_000, 20_000).emit, true);
  assert.equal(coalesceGate(null, NOW, 0).emit, true);
});

// ---- #834: thẻ chờ chủ không tính là im ----
const IDLE = { updated_at: at(130), entered_column_at: at(130) };
const sweepKinds = (o) => planSweep({ columns: COLS, now: NOW, ...o }).map((a) => a.kind);

test('(#834) sweep: thẻ im 130p KHÔNG cờ ⇒ pm (đối chứng)', () => {
  assert.deepEqual(sweepKinds({ tasks: [task(1, 12, 'DEV A', IDLE)], staff: [st('DEV A')] }), ['pm']);
});
test('(#834) sweep: owner_hold ⇒ không HỎI / BÁO PM', () => {
  const ws = { 1: { owner_hold: { kind: 'owner', waiting: 'chủ duyệt' } } };
  assert.deepEqual(sweepKinds({ tasks: [task(1, 12, 'DEV A', IDLE)], staff: [st('DEV A')], workStates: ws }), []);
  assert.deepEqual(sweepKinds({ tasks: [task(1, 12, 'DEV A', { updated_at: at(90), entered_column_at: at(90) })], staff: [st('DEV A')], workStates: ws }), []);
});
test('(#834) sweep: blocked owner|permission và waiting_owner cũng không im; blocked pm/dev vẫn im', () => {
  const t = [task(1, 12, 'DEV A', IDLE)];
  assert.deepEqual(sweepKinds({ tasks: t, staff: [st('DEV A')], workStates: { 1: { blocked: 'owner' } } }), []);
  assert.deepEqual(sweepKinds({ tasks: t, staff: [st('DEV A')], workStates: { 1: { blocked: 'permission' } } }), []);
  assert.deepEqual(sweepKinds({ tasks: t, staff: [st('DEV A', { state: 'waiting_owner', task: { task_id: 1 } })] }), []);
  assert.deepEqual(sweepKinds({ tasks: t, staff: [st('DEV A')], workStates: { 1: { blocked: 'pm' } } }), ['pm']);
});
test('(#834) sweep: cờ chờ chủ KHÔNG che mất nhịp trực (lost) và 2 thẻ', () => {
  const ws = { 1: { owner_hold: { kind: 'owner', waiting: 'x' } } };
  assert.deepEqual(sweepKinds({ tasks: [task(1, 12, 'DEV A', IDLE)], staff: [st('DEV A', { last_seen_at: at(30) })], workStates: ws }), ['lost']);
});

// ---- #834: watch lọc ----
import { isGopYTalk, isOwnerColumnNoise } from '../lib/watch-filter.mjs';
const itm = (o) => ({ id: 1, kind: 'mention', task: '1001#810', text: 'ghi chú', at: at(1), ...o });
test('(#834) watch: tin thường trên thẻ ở "Cần anh xử lý" ⇒ bỏ owner-wait', () => {
  const r = filterInbox([itm({})], { columns: { 810: 'Cần anh xử lý' }, now: NOW });
  assert.deepEqual(r.drop.map((d) => d.reason), ['owner-wait']); assert.equal(r.keep.length, 0);
});
test('(#834) watch: cột khác / không biết cột ⇒ giữ như cũ', () => {
  assert.equal(filterInbox([itm({})], { columns: { 810: 'Đang làm' }, now: NOW }).keep.length, 1);
  assert.equal(filterInbox([itm({})], { now: NOW }).keep.length, 1);
});
test('(#834) watch: ở Cần anh xử lý nhưng có ? / GO / KHẨN / ⛔ KẸT mới / owner_reply / decision ⇒ VẪN thức', () => {
  const ctx = { columns: { 810: 'Cần anh xử lý' }, now: NOW };
  for (const o of [{ text: 'làm tiếp được không?' }, { text: 'xin GO' }, { text: 'KHẨN: lỗi' }, { text: '⛔ KẸT: permission · mới' }, { kind: 'owner_reply', text: 'ok' }, { kind: 'decision', text: 'làm lại' }]) {
    assert.equal(filterInbox([itm({ id: Math.random() * 1e6 | 0, ...o })], ctx).keep.length, 1, JSON.stringify(o));
  }
});
test('(#834) isOwnerColumnNoise: chỉ cột Cần anh xử lý', () => {
  assert.equal(isOwnerColumnNoise(itm({}), 'Cần anh xử lý'), true);
  assert.equal(isOwnerColumnNoise(itm({}), 'Chờ duyệt'), false);
});
test('(#834) isGopYTalk: gop-y thường ⇒ true; gop-y + khan / thẻ thường / không biết ⇒ false', () => {
  assert.equal(isGopYTalk({ labels: ['gop-y', '@THƯ KÝ'] }), true);
  assert.equal(isGopYTalk({ labels: ['gop-y', 'khan'] }), false);
  assert.equal(isGopYTalk({ labels: ['x'] }), false);
  assert.equal(isGopYTalk(undefined), false);
});
