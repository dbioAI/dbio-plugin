import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignMentions, buildReason, evaluateSession, formatHire, hireArgs, isApprovalColumn, normName, reasonArgs, sameName, taskRef, treeMode } from '../lib/staff-logic.mjs';
import { isSelf } from '../lib/watch-filter.mjs';
process.env.DBIO_PM_NAME = 'PM'; // tên trưởng nhóm theo workspace

// ---- #704.1/2: mã thẻ dạng đầy đủ + lý do duyệt
test('taskRef: luôn <board>#<thẻ>, nhận số trần / #n / board#n', () => {
  assert.equal(taskRef(1001, 704), '1001#704');
  assert.equal(taskRef(1001, '#704'), '1001#704');
  assert.equal(taskRef(1001, '1001#704'), '1001#704');
  assert.equal(taskRef('1001', '7'), '1001#7');
});
test('taskRef: sai mã thẻ / board ⇒ ném lỗi', () => {
  assert.throws(() => taskRef(1001, 'abc')); assert.throws(() => taskRef(1001, 0)); assert.throws(() => taskRef(undefined, 5));
});
test('buildReason: mặc định ok, text = --state đã gọn khoảng trắng', () => {
  assert.deepEqual(buildReason({ state: '  Xong  việc  ' }), { level: 'ok', text: 'Xong việc', result: { summary: 'Xong việc' } });   // #809: ok cũng có result
  assert.equal(buildReason({ level: true, state: 'x' }).level, 'ok'); // --level không kèm giá trị
});
test('buildReason: review/blocked + proposal; chữ hoa chấp nhận', () => {
  assert.deepEqual(buildReason({ level: 'REVIEW', state: 'cần duyệt', proposal: 'giảm giá 10%' }), { level: 'review', text: 'cần duyệt', proposal: 'giảm giá 10%' });
  assert.equal(buildReason({ level: 'blocked', state: 'kẹt secret' }).level, 'blocked');
});
test('buildReason: level done kèm result {summary, where, debt}; thiếu where/debt thì bỏ', () => {
  assert.deepEqual(buildReason({ level: 'done', state: 'đã làm', proof: 'sha abc', debt: 'không' }), { level: 'done', text: 'đã làm', result: { summary: 'đã làm', where: 'sha abc', debt: 'không' } });
  assert.deepEqual(buildReason({ level: 'done', state: 'đã làm' }).result, { summary: 'đã làm' });
});
test('buildReason: mức lạ / thiếu text ⇒ ném lỗi', () => {
  assert.throws(() => buildReason({ level: 'fine', state: 'x' }), /--level/);
  assert.throws(() => buildReason({ state: '   ' }), /--state/);
});
test('reasonArgs: task dạng đầy đủ + as', () => {
  assert.deepEqual(reasonArgs(1001, 704, 'DEV', { level: 'ok', text: 't' }), { task: '1001#704', approval_reason: { level: 'ok', text: 't' }, as: 'DEV' });
});
test('isApprovalColumn: bỏ khác biệt hoa-thường/khoảng trắng', () => {
  assert.ok(isApprovalColumn('Chờ duyệt')); assert.ok(isApprovalColumn(' chờ  DUYỆT ')); assert.ok(!isApprovalColumn('Xong')); assert.ok(!isApprovalColumn(null));
});

// ---- #669: chuẩn hoá tên (hr checkin / check)
test('normName: gộp khoảng trắng, bỏ đầu-cuối, hạ chữ thường', () => {
  assert.equal(normName('  DEV   AI\tCHARACTER '), 'dev ai character');
  assert.equal(normName(null), '');
});
test('sameName: tên phiên chỉ khác khoảng trắng/hoa-thường vẫn khớp; chữ "s" KHÔNG bị nuốt (lỗi cũ /s+/)', () => {
  assert.ok(sameName('Tester', 'tester')); assert.ok(sameName('Tester', ' Tester ')); assert.ok(sameName('DEV  PLATFORM', 'dev platform'));
  assert.ok(!sameName('Tester', 'Te ter')); assert.ok(!sameName('Tester', 'Tester 2'));
});

// ---- #679: không @nhắc chính người giao; inbox ẩn tin của mình
test('assignMentions: nhắc người nhận, KHÔNG nhắc chính mình', () => {
  assert.deepEqual(assignMentions('DEV A', 'PM'), ['DEV A']);
  assert.deepEqual(assignMentions('pm ', 'PM'), []);
});
test('isSelf dùng chung với watch: chỉ khi from_character_id == meId', () => {
  assert.ok(isSelf({ from_character_id: 7 }, 7)); assert.ok(isSelf({ from_character_id: '7' }, 7));
  assert.ok(!isSelf({ from_character_id: 8 }, 7)); assert.ok(!isSelf({ from_user_id: 7 }, 7)); assert.ok(!isSelf({ from_character_id: 7 }, null));
});

// ---- #682: nhiều phiên cùng tên
const S = (id, o = {}) => ({ id, title: 'DEV', model: 'm', ...o });
test('#682: 1 phiên ⇒ như cũ (handled=false, không ghi chú)', () => {
  const r = evaluateSession([S('local_a')], { serverRef: 'local_a' });
  assert.deepEqual([r.ses.id, r.handled, r.bad, r.notes], ['local_a', false, [], []]);
});
test('#682: không có phiên ⇒ no_session', () => assert.deepEqual(evaluateSession([], {}).bad, ['no_session']));
test('#682: >1 phiên, phiên đang chạy (mới nhất) = server giữ ⇒ ✓ + ghi chú trùng tên', () => {
  const r = evaluateSession([S('local_new'), S('local_old')], { serverRef: 'local_new' });
  assert.equal(r.bad.length, 0); assert.equal(r.handled, true); assert.match(r.notes[0], /có 2 phiên trùng tên — đóng\/đổi tên phiên thừa/);
});
test('#682: >1 phiên, --session = phiên server giữ (không phải mới nhất) ⇒ ✓', () => {
  const r = evaluateSession([S('local_new'), S('local_old')], { sessionId: 'local_old', serverRef: 'local_old' });
  assert.equal(r.ses.id, 'local_old'); assert.equal(r.bad.length, 0);
});
test('#682: >1 phiên, phiên này KHÔNG phải phiên server giữ ⇒ LỆCH "không giữ vai (server giữ …xxxx)"', () => {
  const r = evaluateSession([S('local_new'), S('local_0123456789abcdef')], { serverRef: 'local_0123456789abcdef' });
  assert.equal(r.bad.length, 1); assert.match(r.bad[0], /phiên này không giữ vai \(server giữ …89abcdef/);
});
test('#682: >1 phiên nhưng server giữ phiên ngoài danh sách ⇒ để luật so serverRef thường xử lý (handled=false) + ghi chú', () => {
  const r = evaluateSession([S('local_a'), S('local_b')], { serverRef: 'local_zzz' });
  assert.deepEqual([r.handled, r.bad.length, r.notes.length], [false, 0, 1]);
});

// ---- #675: deploy done không cần khoá cây
test('treeMode: chỉ-đọc + cây sẵn sàng ⇒ readonly (không khoá); thiếu cây/node_modules hoặc lệnh ghi ⇒ locked', () => {
  assert.equal(treeMode({ readOnly: true, treeExists: true, hasNodeModules: true }), 'readonly');
  assert.equal(treeMode({ readOnly: true, treeExists: false, hasNodeModules: false }), 'locked');
  assert.equal(treeMode({ readOnly: true, treeExists: true, hasNodeModules: false }), 'locked');
  assert.equal(treeMode({ readOnly: false, treeExists: true, hasNodeModules: true }), 'locked'); // run/ask/migrate giữ khoá
  assert.equal(treeMode({ treeExists: true, hasNodeModules: true }), 'locked');
});

// ---- #736: thuê tri thức
test('hireArgs: task đầy đủ, character gọn, model tuỳ chọn, as người thuê', () => {
  assert.deepEqual(hireArgs(1001, '#736', 'PM', '  DEV   B ', 'opus'), { task: '1001#736', character: 'DEV B', model: 'opus', as: 'PM' });
  assert.deepEqual(hireArgs(1001, 736, null, 'DEV B', true), { task: '1001#736', character: 'DEV B' });
  assert.throws(() => hireArgs(1001, 736, 'PM', true), /--character/);
  assert.throws(() => hireArgs(1001, 736, 'PM', '   '), /--character/);
  assert.throws(() => hireArgs(1001, 'x', 'PM', 'A'));
});
test('formatHire: đúng 2 dòng; counted / không cộng; tỉ lệ % hoặc —', () => {
  const r = { task: '1001#736', counted: true, character: { name: 'DEV B' }, hire: { model: 'opus' }, stats: { d7: 3, total: 10, first_pass_rate: 0.8, last_task: '1001#736' } };
  const out = formatHire(r).split('\n');
  assert.equal(out.length, 2);
  assert.equal(out[0], 'ok 1001#736 · thuê tri thức DEV B (opus) · đã tính +1');
  assert.equal(out[1], 'DEV B: 3 (7 ngày) · tổng 10 · đạt lần đầu 80% · lần cuối 1001#736');
  const again = formatHire({ ...r, counted: false, hire: {}, stats: { d7: 1, total: 1, first_pass_rate: null } }).split('\n');
  assert.match(again[0], /đã có — không cộng thêm$/);
  assert.doesNotMatch(again[0], /\(/);
  assert.match(again[1], /đạt lần đầu —$/);
});

// #828 — thẻ góp ý
import { proposeSpec } from '../lib/staff-logic.mjs';
test('(#828) proposeSpec thường: chỉ nhãn gop-y, không @nhắc', () => {
  const s = proposeSpec({ title: 'T', body: 'B', who: 'X', now: 'n' });
  assert.equal(s.title, 'Góp ý: T'); assert.deepEqual(s.labels, ['gop-y']); assert.equal(s.wakeNote, null);
});
test('(#828) proposeSpec --urgent: nhãn khan + @PM + @nhắc có chữ KHẨN', () => {
  const s = proposeSpec({ title: 'T', who: 'X', now: 'n', urgent: true });
  assert.deepEqual(s.labels, ['gop-y', 'khan', '@PM']); assert.match(s.wakeNote, /KHẨN @PM/);
});
