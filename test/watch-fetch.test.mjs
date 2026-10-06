import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ackStale, fetchFreshItems } from '../lib/watch-fetch.mjs';
import { directGate, filterInbox, isCopy, isSecretary } from '../lib/watch-filter.mjs';

const T0 = Date.parse('2026-10-03T10:00:00Z');
const ts = (i) => new Date(T0 + i * 1000).toISOString();
/** n tin chưa đọc id 1..n (cũ → mới). */
const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 'mention', task: '1001#700', from_character_id: 9, text: `t${i + 1}`, at: ts(i), ...extra }));

/** Máy chủ giả. mode 'new': hiểu ids/order; 'old': bỏ qua ids/order, trả 50 tin chưa đọc CŨ nhất. */
function fakeServer(mode, events) {
  const store = events.map((e) => ({ ...e, read: false }));
  const calls = [];
  const ai = async (action, a = {}) => {
    calls.push({ action, a });
    if (action === 'staff_inbox') {
      let rows = store.filter((e) => !e.read || !a.unread_only);
      if (mode === 'new' && Array.isArray(a.ids)) rows = store.filter((e) => a.ids.includes(e.id));
      else rows = [...rows].sort((x, y) => (mode === 'new' && a.order === 'desc' ? y.id - x.id : x.id - y.id));
      return { who: { id: 1 }, items: rows.slice(0, a.limit ?? 30).map(({ read, ...e }) => e) };
    }
    if (action === 'staff_inbox_ack') { for (const e of store) if (a.ids.includes(e.id)) e.read = true; return { success: true }; }
    throw new Error(`lạ ${action}`);
  };
  return { ai, calls, store };
}

test('REGRESSION regression-1: 60 chưa đọc + 1 tin trực tiếp mới ⇒ máy chủ MỚI (ids) hiện được tin mới', async () => {
  const ev = [...mk(60), { id: 61, kind: 'mention', task: '1001#730', from_character_id: 9, text: 'GO không?', at: ts(100) }];
  const s = fakeServer('new', ev);
  const r = await fetchFreshItems(s.ai, 'X', [61]); // pulse mới: ids = 20 tin mới nhất; ở đây chỉ 61 là tươi
  assert.deepEqual(r.items.map((e) => e.id), [61]);
  assert.equal(r.fallback, false);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0].a.ids, [61]);
  const f = filterInbox(r.items, { meId: 1, meName: 'X', now: T0 + 200_000 });
  assert.equal(f.keep.length, 1); assert.equal(f.keep[0].cls, 'urgent');
});

test('máy chủ CŨ: pulse.ids = 50 tin cũ nhất, ids bị bỏ qua ⇒ vẫn ra đúng tin tươi nằm trong cửa sổ, và fallback không làm hỏng', async () => {
  const s = fakeServer('old', mk(60));
  const r = await fetchFreshItems(s.ai, 'X', [3, 4]);
  assert.deepEqual(r.items.map((e) => e.id), [3, 4]);
  assert.deepEqual(r.missing, []);
  assert.equal(r.fallback, false); // đủ id ngay từ lần 1 (cửa sổ 50 chứa chúng) — không gọi thêm
  assert.equal(s.calls.length, 1);
});

test('máy chủ CŨ: có id nằm ngoài cửa sổ 50 ⇒ gọi thêm cửa sổ mặc định, id không tìm thấy vào missing (không nổ)', async () => {
  const s = fakeServer('old', mk(60));
  const r = await fetchFreshItems(s.ai, 'X', [2, 60]);
  assert.deepEqual(r.items.map((e) => e.id), [2]);
  assert.deepEqual(r.missing, [60]);
  assert.equal(r.fallback, true);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].a.ids, undefined); // lần 2 = cửa sổ mặc định như trước
});

test('máy chủ MỚI: id đã được ack giữa chừng ⇒ missing nhưng KHÔNG gọi fallback thừa', async () => {
  const s = fakeServer('new', mk(5));
  s.store[1].read = true; // id 2 bị đọc nơi khác — máy chủ mới vẫn trả "đúng các tin đó" (đã đọc) hoặc không; mô phỏng trả thiếu
  const ai = async (act, a) => { const r = await s.ai(act, a); return act === 'staff_inbox' ? { ...r, items: r.items.filter((e) => e.id !== 2) } : r; };
  const r = await fetchFreshItems(ai, 'X', [1, 2]);
  assert.deepEqual(r.items.map((e) => e.id), [1]);
  assert.deepEqual(r.missing, [2]);
  assert.equal(r.fallback, false);
});

test('không có id ⇒ không gọi mạng', async () => {
  const s = fakeServer('new', mk(3));
  const r = await fetchFreshItems(s.ai, 'X', []);
  assert.deepEqual(r.items, []); assert.equal(s.calls.length, 0);
});

test('ackStale (--fresh): ack mọi tin tạo trước mốc, nhiều trang, không đụng tin mới hơn mốc', async () => {
  const ev = [...mk(120), { id: 121, kind: 'mention', task: '1001#1', text: 'mới sau khi bắt đầu', at: ts(5000) }];
  for (const mode of ['new', 'old']) {
    const s = fakeServer(mode, ev);
    const r = await ackStale(s.ai, 'X', T0 + 1_000_000);
    assert.equal(r.ids.length, 120, mode);
    assert.equal(s.store.filter((e) => !e.read).length, 1, mode);
    assert.equal(s.store.find((e) => !e.read).id, 121, mode);
  }
});

test('ackStale: hộp thư trống ⇒ không ack; ack không có tác dụng ⇒ không lặp vô hạn; lỗi ⇒ trả error', async () => {
  const s0 = fakeServer('new', []);
  assert.deepEqual((await ackStale(s0.ai, 'X', T0)).ids, []);
  assert.equal(s0.calls.filter((c) => c.action === 'staff_inbox_ack').length, 0);
  let n = 0;
  const stuck = async (act) => { n++; return act === 'staff_inbox' ? { items: mk(50) } : {}; };
  const r = await ackStale(stuck, 'X', T0 + 1e6);
  assert.equal(r.ids.length, 50); assert.ok(n <= 4);
  const boom = async (act) => { if (act === 'staff_inbox_ack') throw new Error('hỏng'); return { items: mk(2) }; };
  assert.match((await ackStale(boom, 'X', T0 + 1e6)).error, /hỏng/);
});

// ---- BẢN SAO KHÔNG ĐÁNH THỨC ----
const copy = (o = {}) => ({ id: 500, kind: 'mention', task: '1001#730', from_character_id: 9, text: 'DEV A hỏi DEV B: xong chưa?', at: ts(0), state: 'copy', copy_of: 1301, ...o });

test('isCopy: state copy hoặc copy_of; tin thường không', () => {
  assert.equal(isCopy(copy()), true);
  assert.equal(isCopy({ state: 'copy' }), true);
  assert.equal(isCopy({ copy_of: 5 }), true);
  assert.equal(isCopy({ copy_of: null, state: 'unread' }), false);
  assert.equal(isCopy(null), false);
});

test('bản sao: PM/lead ⇒ bỏ (reason copy) dù nội dung có "?" — không bao giờ thành lý do thức', () => {
  const r = filterInbox([copy(), copy({ id: 501, copy_of: null, state: 'copy', text: 'GO ngay!' })], { meId: 1, now: T0 });
  assert.equal(r.keep.length, 0);
  assert.deepEqual(r.drop.map((d) => d.reason), ['copy', 'copy']);
});

test('bản sao tin nhắc: THƯ KÝ ⇒ giữ, KHẨN (#745: đánh thức phiên đích theo sự kiện); bản sao decision vẫn thường', () => {
  const r = filterInbox([copy()], { meId: 1, now: T0, secretary: true });
  assert.equal(r.keep.length, 1); assert.equal(r.keep[0].cls, 'urgent');
  const d = filterInbox([copy({ kind: 'decision' })], { meId: 1, now: T0, secretary: true });
  assert.equal(d.keep[0].cls, 'normal');
});

test('tin trực tiếp vẫn khẩn khi có bản sao đi kèm', () => {
  const r = filterInbox([copy(), { id: 502, kind: 'mention', task: '1001#731', from_user_id: 1, text: 'GO?', at: ts(1) }], { meId: 1, now: T0 });
  assert.equal(r.keep.length, 1); assert.equal(r.keep[0].id, 502); assert.equal(r.keep[0].cls, 'urgent');
});

test('isSecretary: theo dữ liệu máy chủ hoặc danh sách tên (không phân biệt hoa thường/khoảng trắng)', () => {
  assert.equal(isSecretary({ id: 701 }, 'THƯ KÝ', ['THƯ KÝ']), true);
  assert.equal(isSecretary({ id: 701 }, ' thư  ký ', ['THƯ KÝ']), true);
  assert.equal(isSecretary({ id: 1 }, 'PM'), false);
  assert.equal(isSecretary({ id: 1, access_role: 'secretary' }, 'Ai đó'), true);
  assert.equal(isSecretary({ id: 1, is_secretary: true }, 'Ai đó'), true);
  assert.equal(isSecretary({ id: 1 }, 'Tên khác', ['Tên khác']), true);
  assert.equal(isSecretary(undefined, undefined), false);
});

test('directGate: direct_count=0 ⇒ không thức (trừ trao đổi chờ AI); >0 hoặc máy chủ cũ ⇒ qua; thư ký luôn qua', () => {
  const q = [{ cls: 'urgent', id: 7 }];
  assert.equal(directGate(q, { count: 3, direct_count: 0, copy_count: 3 }), false);
  assert.equal(directGate(q, { count: 3, direct_count: 1, copy_count: 2 }), true);
  assert.equal(directGate(q, { count: 3 }), true); // máy chủ cũ
  assert.equal(directGate(q, undefined), true);
  assert.equal(directGate(q, { direct_count: 0 }, true), true); // thư ký
  assert.equal(directGate([{ cls: 'urgent', id: null, kind: 'talk' }], { direct_count: 0 }), true); // trao đổi chờ AI
});
