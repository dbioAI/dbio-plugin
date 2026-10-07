import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NORMAL_BATCH, NORMAL_MAX_AGE_MS, classify, filterInbox, formatItem, isSelf, parseAssignSignature, parseAt, pickBatch, shouldWake, summarizeLog, taskIdOf, touch } from '../lib/watch-filter.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = Date.parse('2026-10-03T10:00:00Z');
const at = (offS = 0) => new Date(NOW - offS * 1000).toISOString();
let seq = 1;
const it = (o = {}) => ({ id: seq++, kind: 'mention', task: '1001#700', from_character_id: 99, from_user_id: null, text: 'ghi chú', at: at(0), ...o });
const f = (items, ctx = {}) => filterInbox(items, { meId: 1, now: NOW, ...ctx });

test('taskIdOf / parseAt', () => {
  assert.equal(taskIdOf('1001#712'), 712); assert.equal(taskIdOf('#5'), 5); assert.equal(taskIdOf(9), 9); assert.equal(taskIdOf('abc'), null);
  assert.equal(parseAt('2026-10-03 10:00:00'), NOW); assert.equal(parseAt(null, 7), 7);
});

// (a) tin của chính mình
test('(a) tin từ chính mình bị bỏ (self), tin người khác giữ', () => {
  const r = f([it({ from_character_id: 1, kind: 'assign' }), it({ from_character_id: 2, kind: 'assign', task: '1001#701' })]);
  assert.deepEqual(r.drop.map((d) => d.reason), ['self']);
  assert.equal(r.keep.length, 1);
});
test('(a) tin của người duyệt (from_user_id) không phải self', () => {
  assert.equal(f([it({ from_character_id: null, from_user_id: 1, kind: 'owner_reply' })]).keep.length, 1);
});
test('(a) không biết meId ⇒ không bỏ tin nào vì self', () => {
  assert.equal(filterInbox([it({ from_character_id: 1 })], { now: NOW }).keep.length, 1);
});

// (b) decision trên thẻ vừa đụng
test('(b) decision ≤2 phút sau khi tôi move thẻ ⇒ bỏ (touched)', () => {
  const r = f([it({ kind: 'decision', at: at(0) })], { touched: { 700: NOW - 90_000 } });
  assert.equal(r.drop[0]?.reason, 'touched'); assert.equal(r.keep.length, 0);
});
test('(b) decision >2 phút sau khi tôi move ⇒ giữ', () => {
  assert.equal(f([it({ kind: 'decision' })], { touched: { 700: NOW - 200_000 } }).keep.length, 1);
});
test('(b) decision TRƯỚC khi tôi move ⇒ giữ (không phải do tôi gây ra)', () => {
  assert.equal(f([it({ kind: 'decision', at: at(300) })], { touched: { 700: NOW - 100_000 } }).keep.length, 1);
});
test('(b) decision trên thẻ khác ⇒ giữ; kind khác trên thẻ vừa đụng ⇒ giữ', () => {
  assert.equal(f([it({ kind: 'decision', task: '1001#701' })], { touched: { 700: NOW - 10_000 } }).keep.length, 1);
  assert.equal(f([it({ kind: 'owner_reply' })], { touched: { 700: NOW - 10_000 } }).keep.length, 1);
});
test('(b) touch() ghi thẻ + dọn mục > 10 phút', () => {
  const t = touch({ 1: NOW - 11 * 60_000, 2: NOW - 1000 }, 3, NOW);
  assert.deepEqual(Object.keys(t).sort(), ['2', '3']); assert.equal(t[3], NOW);
});

// (c) trùng
test('(c) cùng thẻ + cùng nội dung ≤60s ⇒ bản sau bị bỏ (dup), khác kind vẫn dup', () => {
  const r = f([it({ kind: 'assign', text: 'Làm đi', at: at(30) }), it({ kind: 'mention', text: 'làm  đi', at: at(0) })]);
  assert.equal(r.keep.length, 1); assert.equal(r.drop[0].reason, 'dup');
});
test('(c) cùng nội dung nhưng >60s ⇒ giữ cả hai', () => {
  assert.equal(f([it({ text: 'x', at: at(120) }), it({ text: 'x', at: at(0) })]).keep.length, 2);
});
test('(c) cùng thẻ nhưng nội dung khác ⇒ giữ cả hai (không mất nội dung owner)', () => {
  assert.equal(f([it({ kind: 'owner_reply', text: 'a', at: at(10) }), it({ kind: 'owner_reply', text: 'b', at: at(0) })]).keep.length, 2);
});
test('(c) bản sau KHẨN hơn bản trước thường ⇒ không coi là trùng', () => {
  const r = f([it({ kind: 'children_done', text: 'xong', at: at(20) }), it({ kind: 'ping', text: 'xong', at: at(0) })]);
  assert.equal(r.keep.length, 2);
});
test('(c) chống trùng xuyên lần poll qua recent', () => {
  const a = f([it({ text: 'lặp', at: at(20) })]);
  const b = f([it({ text: 'lặp', at: at(0) })], { recent: a.recent });
  assert.equal(b.drop[0]?.reason, 'dup');
});

// phân loại
test('khẩn: owner_reply, ping, request, assign, nudge, decision, talk', () => {
  for (const kind of ['owner_reply', 'ping', 'request', 'assign', 'nudge', 'decision', 'talk']) assert.equal(classify({ kind, text: '' }), 'urgent', kind);
});
test('khẩn: @mention có ? / GO / kẹt', () => {
  for (const text of ['xong chưa?', 'cần GO store', 'mình đang kẹt ở bước 3', 'BLOCKED bởi migration']) assert.equal(classify({ kind: 'mention', text }), 'urgent', text);
});
test('thường: @mention trần, children_done, new_unassigned, loại lạ (note/report)', () => {
  assert.equal(classify({ kind: 'mention', text: 'fyi đã merge' }), 'normal');
  assert.equal(classify({ kind: 'mention', text: 'going to lunch' }), 'normal'); // "going" không phải GO
  for (const kind of ['children_done', 'new_unassigned', 'note', 'report']) assert.equal(classify({ kind, text: 'ok' }), 'normal', kind);
});
test('thường nhưng báo kẹt ⇒ khẩn (trừ children_done/new_unassigned)', () => {
  assert.equal(classify({ kind: 'report', text: 'đang kẹt' }), 'urgent');
  assert.equal(classify({ kind: 'children_done', text: 'kẹt' }), 'normal');
});
test('filterInbox gắn cls', () => {
  const r = f([it({ kind: 'owner_reply', text: 'a' }), it({ kind: 'children_done', text: 'b', task: '1001#701' })]);
  assert.deepEqual(r.keep.map((x) => x.cls), ['urgent', 'normal']);
});

// gom lô
const q = (cls, ageMin = 0) => ({ cls, firstSeen: NOW - ageMin * 60_000 });
test('hàng đợi rỗng ⇒ không thức', () => assert.equal(shouldWake([], NOW).wake, false));
test('1 tin khẩn ⇒ thức ngay', () => assert.deepEqual([shouldWake([q('urgent')], NOW).wake, shouldWake([q('urgent')], NOW).reason], [true, 'urgent']));
test('4 tin thường mới ⇒ chưa thức', () => assert.equal(shouldWake([q('normal'), q('normal'), q('normal'), q('normal')], NOW).wake, false));
test('đủ 5 tin thường ⇒ thức (batch)', () => {
  const w = shouldWake(Array.from({ length: NORMAL_BATCH }, () => q('normal')), NOW);
  assert.deepEqual([w.wake, w.reason], [true, 'batch']);
});
test('1 tin thường cũ >20 phút ⇒ thức (age); đúng 20 phút chưa thức', () => {
  assert.equal(shouldWake([q('normal', 21)], NOW).reason, 'age');
  assert.equal(shouldWake([{ cls: 'normal', firstSeen: NOW - NORMAL_MAX_AGE_MS }], NOW).wake, false);
});
test('pickBatch: khẩn trước; phần dư giữ lại', () => {
  const items = [{ cls: 'normal', firstSeen: 1, id: 1 }, { cls: 'urgent', firstSeen: 5, id: 2 }, { cls: 'normal', firstSeen: 2, id: 3 }];
  const { show, rest } = pickBatch(items, 2);
  assert.deepEqual(show.map((x) => x.id), [2, 1]); assert.deepEqual(rest.map((x) => x.id), [3]);
});

// định dạng
test('formatItem ≤2 dòng, có thẻ · ai · câu · cột · lớp', () => {
  const out = formatItem({ task: '1001#712', kind: 'owner_reply', from_user_id: 5, text: 'Duyệt chưa? '.repeat(40), cls: 'urgent' }, 'Chờ duyệt');
  const lines = out.split('\n');
  assert.equal(lines.length, 2); assert.match(lines[0], /^1001#712 · người duyệt · người duyệt nhắn: Duyệt chưa\?/);
  assert.match(lines[1], /cột Chờ duyệt · khẩn/); assert.ok(lines[0].length < 300);
});

// nhật ký
test('summarizeLog gộp theo nhân viên, lọc theo thời gian', () => {
  const e = (staff, woke, o = {}) => ({ ts: at(0), staff, woke, items: woke ? 2 : 0, urgent: woke ? 1 : 0, ...o });
  const s = summarizeLog([e('A', true), e('A', false), e('A', false), e('B', true), e('A', true, { ts: at(86400 * 3) })], NOW - 86_400_000);
  assert.deepEqual(s[0], { staff: 'A', exits: 3, woke: 1, items: 2, urgent: 1, polls: 0 });
  assert.deepEqual(s[1], { staff: 'B', exits: 1, woke: 1, items: 2, urgent: 1, polls: 0 });
});

// trạng thái cục bộ (đường dẫn nhật ký qua biến môi trường)
test('logWatchExit + readWatchLog khứ hồi', async () => {
  process.env.DBIO_WATCH_LOG = join(mkdtempSync(join(tmpdir(), 'dbio-')), 'sub', 'w.jsonl');
  const { logWatchExit, readWatchLog } = await import('../lib/watch-state.mjs');
  logWatchExit({ staff: 'X', woke: true, items: 1, urgent: 1 }); logWatchExit({ staff: 'X', woke: false, items: 0, urgent: 0 });
  const rows = readWatchLog();
  assert.equal(rows.length, 2); assert.equal(rows[0].staff, 'X'); assert.ok(rows[0].ts);
  delete process.env.DBIO_WATCH_LOG;
});

// #678 — tin giao việc do CHÍNH MÌNH tạo (`staff assign`) không được đánh thức người giao
const SIG_TIME = '2026-10-03T09:59Z';
const assignText = (to, by, brief = 'Mục tiêu: sửa editor · Thao tác chung cần GO: không') => `📌 GIAO VIỆC → ${to} · ${by} · ${SIG_TIME}\n${brief}`;
// Hình dạng thật 3/10: mention trên thẻ #718, from_character_id = id NGƯỜI NHẬN (702), chữ ký có tên PM.
const realAssign = (o = {}) => it({ kind: 'mention', task: '1001#718', from_character_id: 702, text: assignText('DEV C', 'PM'), ...o });

test('(#678) chữ ký "GIAO VIỆC" do chính mình (PM) tạo ⇒ bỏ (self) dù from_character_id là người nhận', () => {
  const r = filterInbox([realAssign()], { meId: 703, meName: 'PM', now: NOW });
  assert.deepEqual(r.drop.map((d) => d.reason), ['self']); assert.equal(r.keep.length, 0);
});
test('(#678) cùng tin ấy với người nhận DEV C (id 702) ⇒ giữ và khẩn (cần GO)', () => {
  const r = filterInbox([realAssign()], { meId: 702, meName: 'DEV C', now: NOW });
  assert.equal(r.keep.length, 1); assert.equal(r.keep[0].cls, 'urgent'); assert.equal(r.drop.length, 0);
});
test('(#678) so tên người giao không phân biệt hoa thường/khoảng trắng; người giao khác ⇒ không self', () => {
  assert.equal(isSelf(realAssign(), 703, 'pm'), true);
  assert.equal(isSelf(realAssign(), 703, 'PM khác'), false);
});
test('(#678) trường tác giả bình luận gốc (by_staff_id / author_staff_id) ưu tiên hơn from_character_id', () => {
  assert.equal(isSelf(it({ from_character_id: 702, by_staff_id: 703, text: 'x' }), 703, 'PM'), true);
  assert.equal(isSelf(it({ from_character_id: 703, author_staff_id: 702, text: 'x' }), 703, 'PM'), false);
});
test('(#678) parseAssignSignature đọc người nhận + người giao', () => {
  assert.deepEqual(parseAssignSignature(assignText('A B', 'C D')), { to: 'A B', by: 'C D' });
  assert.equal(parseAssignSignature('giao việc thường'), null);
});
test('(#678) echo giao việc ≤2 phút (assign / mention chữ ký / mention rỗng) ⇒ bỏ (assigned); >2 phút ⇒ giữ', () => {
  const asg = { assigned: { 700: NOW - 30_000 } };
  const r1 = f([it({ kind: 'assign', text: 'giao', at: at(0) })], asg);
  assert.equal(r1.drop[0]?.reason, 'assigned'); assert.equal(r1.keep.length, 0);
  assert.equal(f([it({ kind: 'mention', text: assignText('B', 'A'), at: at(0) })], asg).drop[0]?.reason, 'assigned');
  assert.equal(f([it({ kind: 'mention', text: '', at: at(0) })], asg).drop[0]?.reason, 'assigned');
  assert.equal(f([it({ kind: 'assign', text: 'y' })], { assigned: { 700: NOW - 200_000 } }).keep.length, 1);
});
test('(#678) người nhận hỏi lại 30s sau khi tôi giao ⇒ GIỮ + khẩn (không bị nuốt); mention thường ⇒ giữ, phân loại bình thường', () => {
  const asg = { assigned: { 700: NOW - 30_000 } };
  const r = f([it({ kind: 'mention', text: 'Brief này thiếu phạm vi, làm cả mobile không?', at: at(0) })], asg);
  assert.equal(r.drop.length, 0); assert.equal(r.keep[0].cls, 'urgent');
  const n = f([it({ kind: 'mention', text: 'đã nhận, bắt đầu làm', at: at(0) })], asg);
  assert.equal(n.keep.length, 1); assert.equal(n.keep[0].cls, 'normal');
});
test('(#678) assigned không ảnh hưởng thẻ khác / kind khác (owner_reply vẫn giữ)', () => {
  assert.equal(f([it({ kind: 'assign', task: '1001#701', text: 'a?' })], { assigned: { 700: NOW - 10_000 } }).keep.length, 1);
  assert.equal(f([it({ kind: 'owner_reply' })], { assigned: { 700: NOW - 10_000 } }).keep.length, 1);
});
test('(#678) GO khớp nguyên từ theo Unicode: GIAO/GOOD/going/ĐGO không khớp', () => {
  for (const text of ['📌 GIAO VIỆC → A · B · 2026-10-03T09:59Z\nsửa editor', 'GOOD job', 'going home', 'ĐGO', 'GOÀN']) assert.equal(classify({ kind: 'mention', text }), 'normal', text);
  for (const text of ['cần GO', 'GO!', '(GO)', 'xin go store']) assert.equal(classify({ kind: 'mention', text }), 'urgent', text);
});
test('(#678) recordAssign ghi cả assigned lẫn touched (đọc lại được)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dbio-home-')); process.env.USERPROFILE = home; process.env.HOME = home; // không ghi vào ~/.dbio thật
  const st = await import('../lib/watch-state.mjs');
  const name = `t678-${Date.now()}`;
  st.recordAssign(name, 718);
  assert.ok(st.loadAssigned(name)[718] > 0); assert.ok(st.loadTouched(name)[718] > 0);
});

test('summarizeLog cộng polls (#759); dòng cũ không có polls tính 0', () => {
  const at = (s) => new Date(NOW - s * 1000).toISOString();
  const s = summarizeLog([{ ts: at(10), staff: 'A', woke: false, polls: 120 }, { ts: at(20), staff: 'A', woke: true, items: 1, polls: 30 }, { ts: at(30), staff: 'A', woke: false }], 0);
  assert.equal(s[0].polls, 150);
  assert.equal(s[0].exits, 3);
});

// #828 — góp ý: không thức trừ KHẨN
test('(#828) tin thường về thẻ góp ý bị bỏ (gop-y); góp ý KHẨN vẫn giữ + khẩn', () => {
  const quiet = it({ kind: 'new_unassigned', task: '1001#900', text: 'Góp ý: thiếu script X' });
  const quiet2 = it({ kind: 'mention', task: '1001#703', text: '**Góp ý quy trình** (từ A) bước lặp tay' });
  const urgent = it({ kind: 'mention', task: '1001#902', text: '🚨 KHẨN @PM: lộ khoá — cần PM' });
  const other = it({ kind: 'new_unassigned', task: '1001#903', text: 'Làm trang chủ' });
  const r = f([quiet, quiet2, urgent, other]);
  assert.deepEqual(r.drop.map((d) => d.reason), ['gop-y', 'gop-y']);
  assert.deepEqual(r.keep.map((k) => [k.task, k.cls]), [['1001#902', 'urgent'], ['1001#903', 'normal']]);
});

// #833: chủ duyệt thẻ ⇒ không thức
import { isApproveDecision } from '../lib/watch-filter.mjs';
test('#833 decision approve ⇒ bỏ (approved), không vào hàng đợi khẩn', () => {
  for (const o of [{ decision: 'approve', text: '' }, { text: 'Chủ đã duyệt thẻ' }, { text: 'quyết định: approve' }, { text: 'Chủ xác nhận — thẻ sang Xong' }]) {
    const r = f([it({ kind: 'decision', ...o })]);
    assert.deepEqual(r.drop.map((d) => d.reason), ['approved'], JSON.stringify(o));
    assert.equal(r.keep.length, 0);
  }
});
test('#833 decision reject/review/gỡ chặn/mơ hồ ⇒ vẫn thức (khẩn)', () => {
  for (const o of [{ decision: 'reject' }, { text: 'quyết định: reject' }, { text: 'Chủ yêu cầu review lại' }, { text: 'Chủ không duyệt — làm lại' }, { text: 'Chủ đã gỡ chặn — làm tiếp' }, { text: 'quay lại Đang làm' }, { text: 'ghi chú gì đó' }, { text: 'duyệt không?' }]) {
    const r = f([it({ kind: 'decision', ...o })]);
    assert.equal(r.keep.length, 1, JSON.stringify(o)); assert.equal(r.keep[0].cls, 'urgent');
  }
});
test('#833 owner_reply (chủ nhắn) chứa chữ duyệt ⇒ vẫn thức; isApproveDecision chỉ cho decision', () => {
  assert.equal(f([it({ kind: 'owner_reply', text: 'đã duyệt, nhưng thêm chỗ này' })]).keep.length, 1);
  assert.equal(isApproveDecision({ kind: 'mention', text: 'approve' }), false);
});

test('#872 nợ 3/5: bình luận do CHÍNH MÌNH gửi (ref_id trong outbox) dội lại — kể cả bản sao/@nhắc — bị bỏ; ref_id lạ vẫn giữ', () => {
  const own = it({ kind: 'mention', ref_id: 777, from_character_id: null, from_user_id: 1 });
  const other = it({ kind: 'mention', ref_id: 778, from_character_id: null, from_user_id: 1 });
  const r = f([own, other], { outbox: { 777: Date.now() } });
  assert.deepEqual(r.drop.map((d) => [d.item.ref_id, d.reason]), [[777, 'self-ref']]);
  assert.deepEqual(r.keep.map((i) => i.ref_id), [778]);
  assert.equal(f([own]).keep.length, 1, 'không có outbox ⇒ như cũ');
});
