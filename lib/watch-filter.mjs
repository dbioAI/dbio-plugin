/**
 * lib/watch-filter.mjs — bộ LỌC + PHÂN LOẠI tin cho `dbio staff watch` (hàm THUẦN, không IO, không mạng; có test).
 * Mục tiêu: chỉ đánh thức phiên (tốn token) khi có việc CẦN QUYẾT; mỗi lần thức = 1 lệnh gọi.
 *
 * Lọc (bỏ + tự ack, 0 token):
 *   self     — tin do CHÍNH MÌNH gửi dội lại: chữ ký "📌 GIAO VIỆC → <người nhận> · <người giao> · <giờ>" của `staff assign` (người giao == tôi),
 *              hoặc trường tác giả bình luận gốc (by_staff_id / author_staff_id), hoặc from_character_id == tôi.
 *   assigned — ECHO của chính lệnh giao việc trên thẻ TÔI vừa giao ≤ 2 phút: kind `assign`, hoặc `mention` mang chữ ký giao việc / không có nội dung.
 *              Mọi mention khác (người nhận hỏi lại, trả lời…) GIỮ và phân loại bình thường — không được nuốt mất.
 *   touched  — `decision` tới sau khi TÔI vừa move/done/assign chính thẻ đó (≤ 2 phút).
 *   approved — #833: `decision` = chủ DUYỆT/xác nhận thẻ (thẻ tự sang Xong) ⇒ bỏ + tự ack, KHÔNG thức. Cần tín hiệu approve RÕ và KHÔNG có
 *              tín hiệu quay lại (reject/review/từ chối/làm lại/sửa/gỡ chặn/làm tiếp/kẹt/?); mơ hồ ⇒ vẫn thức. owner_reply (chủ nhắn) không đụng.
 *   dup      — cùng thẻ + cùng nội dung (không có nội dung ⇒ cùng loại) trong 60 giây, trừ khi bản sau KHẨN hơn bản trước.
 *   gop-y    — #828: tin THƯỜNG về thẻ góp ý ("Góp ý: …", ở Đang trao đổi, bóng phía chủ) ⇒ không thức, bỏ + tự ack. Góp ý KHẨN (chữ KHẨN) vẫn thức.
 *   copy     — BẢN SAO của tin @nhắc giữa nhân viên (state 'copy' / copy_of != null, gửi cho thư ký nhóm hoặc trưởng nhóm khi không có thư ký):
 *              KHÔNG phải lý do thức ⇒ bỏ + tự ack, chỉ đếm vào dòng tóm tắt. Riêng THƯ KÝ thì đó là VIỆC CỦA NÓ ⇒ giữ, phân loại 'normal'.
 * Phân loại còn lại:
 *   urgent — owner_reply · ping · request(xin GO) · assign · nudge · decision · mention có "?"/GO/kẹt/blocked · talk (thẻ trao đổi chờ AI) ⇒ thức NGAY.
 *   normal — children_done · new_unassigned · ghi chú/báo cáo/loại lạ ⇒ gom; thức khi ≥5 tin hoặc tin cũ nhất > 20 phút.
 */
export const NORMAL_BATCH = 5;
export const NORMAL_MAX_AGE_MS = 20 * 60_000;
export const TOUCH_WINDOW_MS = 2 * 60_000;
export const DUP_WINDOW_MS = 60_000;
export const ASSIGN_WINDOW_MS = 2 * 60_000;
export const MAX_SHOW = 10;
export const COALESCE_MS = 20_000;

/** Tên các nhân viên mang vai thư ký (cấu hình) — bản sao tin là việc của họ khi máy chủ chưa trả access_role. */
export const DEFAULT_SECRETARIES = []; // tên thư ký theo workspace: config watch.json (máy dev: kho nội bộ/config; máy khách: ~/.dbio/watch.json); server trả access_role thì khỏi cần
const URGENT_KINDS = new Set(['owner_reply', 'ping', 'request', 'assign', 'owner_assign', 'nudge', 'decision', 'talk']); // owner_assign (#745): chủ/PM giao thẻ thẳng cho nhân viên — tin vào hộp thư thư ký
/** Thư ký: bản sao các loại tin này = có phiên khác cần được đánh thức ⇒ khẩn (theo sự kiện). Bản sao loại khác (decision, children_done…) vẫn thường. */
const SECRETARY_WAKE_KINDS = new Set(['mention', 'assign', 'owner_assign', 'ping', 'request', 'nudge']);
// Biên từ theo Unicode: \b của JS coi chữ có dấu KHÔNG phải ký tự từ ⇒ dùng lookaround \p{L}\p{N}. "GIAO"/"GOOD"/"going" không khớp GO.
const WORD = (w) => String.raw`(?<![\p{L}\p{N}_])${w}(?![\p{L}\p{N}_])`;
const MENTION_URGENT = new RegExp(String.raw`\?|${WORD('GO')}|kẹt|${WORD('blocked')}|${WORD('HOLD')}|${WORD('KHẨN')}`, 'iu');
const STUCK = new RegExp(`${WORD('blocked')}|kẹt`, 'iu');

/** "1001#712" | "#712" | 712 ⇒ 712 (hoặc null). */
export function taskIdOf(ref) {
  const n = Number(String(ref ?? '').replace(/^#/, '').split('#').pop());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Thời gian máy chủ ("2026-10-03 01:02:03" UTC hoặc ISO) ⇒ ms; không đọc được ⇒ fallback. */
export function parseAt(s, fallback = NaN) {
  if (!s) return fallback;
  const t = Date.parse(String(s).includes('T') ? String(s) : `${String(s).replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? fallback : t;
}

/** 'urgent' | 'normal'. */
export function classify(item) {
  const kind = String(item?.kind ?? '');
  const text = String(item?.text ?? '');
  if (URGENT_KINDS.has(kind)) return 'urgent';
  if (kind === 'mention') return MENTION_URGENT.test(text) ? 'urgent' : 'normal';
  // children_done / new_unassigned luôn thường; loại lạ (ghi chú, báo cáo…) vẫn thức ngay nếu báo kẹt
  if (kind === 'children_done' || kind === 'new_unassigned') return 'normal';
  return STUCK.test(text) ? 'urgent' : 'normal';
}

/** Chữ ký do `staff assign` sinh: "📌 GIAO VIỆC → <người nhận> · <người giao> · <ISO>" ⇒ {to, by} | null. */
export function parseAssignSignature(text) {
  const m = /📌\s*GIAO VIỆC\s*→\s*(.+?)\s*·\s*(.+?)\s*·\s*\d{4}-\d{2}-\d{2}T[\d:]+Z?/u.exec(String(text ?? '').replace(/<[^>]+>/g, ' '));
  return m ? { to: m[1].trim(), by: m[2].trim() } : null;
}
const normName = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
const AUTHOR_FIELDS = ['by_staff_id', 'author_staff_id'];

/**
 * Tin do CHÍNH MÌNH gửi — dùng chung watch + inbox (#679, #678).
 * Thứ tự tin cậy: (1) chữ ký giao việc (cần meName): from_character_id của sự kiện mention là NGƯỜI NHẬN nên KHÔNG dùng khi có chữ ký —
 * người giao == meName ⇒ self, khác ⇒ không self; (2) trường tác giả của bình luận gốc; (3) from_character_id.
 */
export function isSelf(item, meId, meName) {
  if (!item) return false;
  const sig = meName ? parseAssignSignature(item.text) : null;
  if (sig) return normName(sig.by) === normName(meName);
  if (meId == null) return false;
  for (const f of AUTHOR_FIELDS) if (item[f] != null) return Number(item[f]) === Number(meId);
  return item.from_character_id != null && Number(item.from_character_id) === Number(meId);
}

/** Bản sao của tin @nhắc giữa nhân viên (máy chủ mới: state 'copy' / copy_of = id nhân vật gốc). */
export const isCopy = (it) => !!it && (it.state === 'copy' || (it.copy_of != null && it.copy_of !== ''));

/**
 * Người đang canh có phải THƯ KÝ không? Ưu tiên dữ liệu máy chủ (who.access_role / who.role == 'secretary', hoặc who.secretary / who.is_secretary);
 * máy chủ chưa trả thì dựa danh sách tên cấu hình (mặc định DEFAULT_SECRETARIES; đè bằng config/watch.json {"secretaries": [...]}).
 */
export function isSecretary(who, name, list = DEFAULT_SECRETARIES) {
  const role = String(who?.access_role ?? who?.role ?? '').toLowerCase();
  if (role === 'secretary' || role === 'thu_ky') return true;
  if (who?.secretary === true || who?.is_secretary === true) return true;
  const n = normName(name);
  return !!n && list.some((x) => normName(x) === n);
}

/**
 * Cổng "tin trực tiếp" cho watch KHÔNG phải thư ký: máy chủ mới báo unread.direct_count; = 0 (mọi tin chưa đọc đều là bản sao) ⇒ không thức vì hộp thư.
 * Máy chủ cũ (không có direct_count) ⇒ cho qua. Trao đổi chờ AI (hàng đợi mục không có id) vẫn luôn là lý do thức. Thư ký luôn qua.
 */
export function directGate(queue, unread, secretary = false) {
  if (secretary) return true;
  const d = unread?.direct_count;
  if (d == null || d > 0) return true;
  return queue.some((q) => !q.id);
}

/** #833: decision = DUYỆT (không cần ai làm gì). Trường có cấu trúc thắng chữ; mơ hồ ⇒ false (vẫn thức). */
const APPROVE_RE = new RegExp(String.raw`${WORD('approve[d]?')}|${WORD('approval')}|duyệt|xác nhận|chấp thuận|${WORD('accepted')}`, 'iu');
const NOT_APPROVE_RE = new RegExp(String.raw`${WORD('reject(?:ed)?')}|${WORD('review')}|${WORD('revise')}|${WORD('redo')}|${WORD('unblock(?:ed)?')}|từ chối|không duyệt|chưa duyệt|chờ duyệt|làm lại|sửa|gỡ chặn|làm tiếp|tiếp tục|quay lại|kẹt|${WORD('blocked')}|\?`, 'iu');
export function isApproveDecision(it) {
  if (!it || it.kind !== 'decision') return false;
  for (const f of ['decision', 'verdict', 'outcome', 'quick']) {
    const v = it[f];
    if (typeof v === 'string' && v.trim()) { const t = v.trim(); if (/^approve[d]?$/i.test(t)) return true; if (NOT_APPROVE_RE.test(t)) return false; }
  }
  const text = String(it.text ?? '');
  return APPROVE_RE.test(text) && !NOT_APPROVE_RE.test(text);
}

/**
 * #834: tin trên thẻ đang ở cột CHỜ CHỦ ("Cần anh xử lý") — tin thường (ghi chú/nhắc/bình luận của chính PM…) không phải lý do thức:
 * thẻ đã nằm chờ chủ, người khác thêm dòng không đổi gì. Vẫn thức khi: owner_reply/decision (chủ nhắn/quyết), có ?/GO/KHẨN/HOLD, hoặc mở bằng "⛔ KẸT" (kẹt MỚI).
 */
export const OWNER_COLUMNS = ['Cần anh xử lý'];
const NEW_STUCK = /^\s*⛔\s*KẸT/u;
const WAKE_ANYWAY = new RegExp(String.raw`\?|${WORD('GO')}|${WORD('HOLD')}|${WORD('KHẨN')}`, 'iu');
export const isOwnerColumnNoise = (it, column) => OWNER_COLUMNS.includes(String(column ?? '')) && ['mention', 'nudge', 'children_done', 'new_unassigned'].includes(String(it?.kind)) && !WAKE_ANYWAY.test(String(it?.text ?? '')) && !NEW_STUCK.test(String(it?.text ?? '').replace(/<[^>]+>/g, ' '));

/**
 * #834: "trao đổi chờ AI" (talk) trên thẻ GÓP Ý thường (nhãn gop-y, không nhãn khan) ⇒ không thức (#828: góp ý PM duyệt gộp mỗi ngày).
 * card = {labels: [...]}; không có thông tin thẻ ⇒ false (vẫn thức).
 */
export const isGopYTalk = (card) => { const l = (card?.labels ?? []).map((x) => String(x).toLowerCase()); return l.includes('gop-y') && !l.includes('khan'); };

const normText =(s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
const dupKey = (it) => `${taskIdOf(it.task) ?? it.task ?? ''}|${normText(it.text) || it.kind}`;

/** Echo của lệnh `staff assign`: kind assign, hoặc mention mang chữ ký giao việc / rỗng. Mention có nội dung khác ⇒ KHÔNG phải echo. */
const isAssignEcho = (it) => it.kind === 'assign' || (it.kind === 'mention' && (!String(it.text ?? '').trim() || !!parseAssignSignature(it.text)));

/** #828: tin thường (new_unassigned/children_done/mention không có ?/GO/kẹt/KHẨN) nói về thẻ góp ý ⇒ không đáng thức. */
const GOP_Y_TEXT = /(^|[\s>])Góp ý(?: KHẨN)?\s*[:(*]|\*\*Góp ý/u;
export const isGopYNoise = (it) => ['new_unassigned', 'mention', 'children_done'].includes(String(it?.kind)) && GOP_Y_TEXT.test(String(it?.text ?? '')) && classify(it) !== 'urgent';

/**
 * Lọc một lô tin chưa đọc.
 * ctx: {meId, meName, secretary, assigned: {<taskId>: ms}, touched: {<taskId>: ms}, recent: {<dupKey>: {ts, cls}}, columns: {<taskId>: tên cột}, now}
 * ⇒ {keep: [item+cls], drop: [{item, reason}], recent} (recent mới, đã dọn mục cũ).
 */
export function filterInbox(items, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const touched = ctx.touched ?? {};
  const assigned = ctx.assigned ?? {};
  const recent = {};
  for (const [k, v] of Object.entries(ctx.recent ?? {})) if (now - v.ts <= DUP_WINDOW_MS * 2) recent[k] = v;
  const keep = []; const drop = [];
  const sorted = [...items].sort((a, b) => parseAt(a.at, now) - parseAt(b.at, now) || Number(a.id ?? 0) - Number(b.id ?? 0));
  for (const it of sorted) {
    const ts = parseAt(it.at, now);
    if (isSelf(it, ctx.meId, ctx.meName)) { drop.push({ item: it, reason: 'self' }); continue; }
    if (isCopy(it) && !ctx.secretary) { drop.push({ item: it, reason: 'copy' }); continue; }
    const tid = taskIdOf(it.task);
    if (tid && assigned[tid] != null && isAssignEcho(it)) {
      const dt = ts - assigned[tid];
      if (dt >= -30_000 && dt <= ASSIGN_WINDOW_MS) { drop.push({ item: it, reason: 'assigned' }); continue; }
    }
    if (it.kind === 'decision' && tid && touched[tid] != null) {
      const dt = ts - touched[tid];
      if (dt >= -30_000 && dt <= TOUCH_WINDOW_MS) { drop.push({ item: it, reason: 'touched' }); continue; }
    }
    if (isApproveDecision(it)) { drop.push({ item: it, reason: 'approved' }); continue; }
    if (isGopYNoise(it)) { drop.push({ item: it, reason: 'gop-y' }); continue; }
    if (tid && isOwnerColumnNoise(it, (ctx.columns ?? {})[tid])) { drop.push({ item: it, reason: 'owner-wait' }); continue; }
    const cls = isCopy(it) ? (SECRETARY_WAKE_KINDS.has(String(it.kind)) ? 'urgent' : 'normal') : classify(it); // thư ký (#745): bản sao tin nhắc/giao việc = khẩn (đánh thức phiên đích); loại khác thường
    const key = dupKey(it);
    const prev = recent[key];
    if (prev && Math.abs(ts - prev.ts) <= DUP_WINDOW_MS && !(cls === 'urgent' && prev.cls !== 'urgent')) { drop.push({ item: it, reason: 'dup' }); continue; }
    recent[key] = { ts, cls };
    keep.push({ ...it, cls });
  }
  return { keep, drop, recent };
}

/**
 * Gộp tin đến gần nhau thành MỘT lần thức (#678/#745): thấy điều kiện thức lần đầu ⇒ đợi `ms` (mặc định 20s) rồi mới in.
 * pendingSince = mốc thấy điều kiện thức lần đầu (null = chưa) ⇒ {emit, pendingSince}. ms=0 ⇒ in ngay.
 */
export function coalesceGate(pendingSince, now = Date.now(), ms = COALESCE_MS) {
  if (!(ms > 0)) return { emit: true, pendingSince: now };
  if (pendingSince == null) return { emit: false, pendingSince: now };
  return { emit: now - pendingSince >= ms, pendingSince };
}

/** Hàng đợi [{cls, firstSeen}] ⇒ {wake, reason, urgent, normal, oldestMs}. */
export function shouldWake(queue, now = Date.now()) {
  const urgent = queue.filter((q) => q.cls === 'urgent').length;
  const normal = queue.length - urgent;
  const oldestMs = queue.length ? now - Math.min(...queue.map((q) => q.firstSeen ?? now)) : 0;
  let reason = null;
  if (urgent > 0) reason = 'urgent';
  else if (normal >= NORMAL_BATCH) reason = 'batch';
  else if (normal > 0 && oldestMs > NORMAL_MAX_AGE_MS) reason = 'age';
  return { wake: !!reason, reason, urgent, normal, oldestMs };
}

/** Chọn tối đa `max` tin để in: khẩn trước, cũ trước. */
export function pickBatch(queue, max = MAX_SHOW) {
  const order = [...queue].sort((a, b) => (a.cls === 'urgent' ? 0 : 1) - (b.cls === 'urgent' ? 0 : 1) || (a.firstSeen ?? 0) - (b.firstSeen ?? 0));
  return { show: order.slice(0, max), rest: order.slice(max) };
}

/** Ghi nhận "tôi vừa đụng thẻ" (move/done/assign); dọn mục > 10 phút. Trả bản mới. */
export function touch(touched, taskId, now = Date.now()) {
  const out = {};
  for (const [k, v] of Object.entries(touched ?? {})) if (now - v <= 10 * 60_000) out[k] = v;
  if (taskId) out[taskId] = now;
  return out;
}

const KIND_VI = { owner_reply: 'người duyệt nhắn', decision: 'quyết định', ping: 'cần trao đổi', assign: 'giao việc', owner_assign: 'chủ/PM giao thẻ thẳng', request: 'xin GO/quyết', mention: 'nhắc', nudge: 'nhắc việc', children_done: 'thẻ con xong', new_unassigned: 'thẻ mới chưa ai cầm', talk: 'trao đổi chờ AI' };

/** ≤2 dòng: `<thẻ> · <ai> · <loại>: <câu cần quyết>` + `  ↳ cột <cột> · khẩn|thường`. */
export function formatItem(it, column) {
  const who = it.from_character_id ? `nv#${it.from_character_id}` : it.from_user_id ? 'người duyệt' : '-';
  const text = String(it.text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = text.length > 220 ? `${text.slice(0, 220)}…` : text;
  return `${it.task ?? '?'} · ${who} · ${KIND_VI[it.kind] ?? it.kind}${cut ? `: ${cut}` : ''}\n  ↳ cột ${column ?? '?'} · ${it.cls === 'urgent' ? 'khẩn' : 'thường'}`;
}

/** Nhật ký thoát watch [{ts, staff, woke, items, urgent, polls}] ⇒ [{staff, exits, woke, items, urgent, polls}] (nhiều lần thức nhất trước). */
export function summarizeLog(entries, sinceMs = 0) {
  const by = new Map();
  for (const e of entries) {
    if (!e || !e.staff || Date.parse(e.ts) < sinceMs) continue;
    const s = by.get(e.staff) ?? { staff: e.staff, exits: 0, woke: 0, items: 0, urgent: 0, polls: 0 };
    s.exits++; if (e.woke) s.woke++; s.items += e.items ?? 0; s.urgent += e.urgent ?? 0; s.polls += e.polls ?? 0; // polls = số lần gọi staff_pulse của lượt watch đó (#759)
    by.set(e.staff, s);
  }
  return [...by.values()].sort((a, b) => b.exits - a.exits);
}
