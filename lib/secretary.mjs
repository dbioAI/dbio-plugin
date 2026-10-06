/**
 * lib/secretary.mjs — phần THUẦN (không IO, không mạng; có test) của "thư ký thức theo sự kiện" (#745 phần 2) và `dbio staff next` (#745 phần 3).
 *
 * QUÉT SỔ CÁI bằng script (0 token) thay cho việc thư ký (LLM) thức định kỳ 55 phút để đọc sổ cái. Chỉ khi quét ra VIỆC thật
 * (hoặc watch có tin) thì phiên thư ký mới được thức. Việc = hành động cụ thể: nhắn phiên nào, nội dung gì, hay ghi lên thẻ gì.
 *   wake     thẻ Đã giao mà người nhận chưa ACK (assigned_unacked / quá hạn ACK) ⇒ nhắn phiên đó tin NẠP LẠI (lặp lại mỗi ≥10')
 *   ask      thẻ Đang làm / Đã giao im > 60' (không bình luận, không đổi cột) ⇒ hỏi người cầm "đang LÀM hay đang CHỜ gì" (1 lần / giờ / thẻ)
 *   pm       thẻ im > 120' ⇒ ghi lên thẻ kèm @PM (1 lần / 2 giờ / thẻ)
 *   lost     người cầm thẻ Đang làm mà mất nhịp trực > 10' ⇒ gắn cờ trên thẻ (1 lần / giờ / thẻ)
 *   nosess   người cầm thẻ không có phiên (runtime.session_ref) ⇒ không đánh thức được, báo PM (1 lần / giờ / thẻ)
 *   double   một nhân viên cầm ≥2 thẻ cùng lúc (Đang làm + Đã giao) ⇒ báo PM (luật phòng mục 2: một phiên = một thẻ)
 * Cột "Cần anh xử lý" / "Chờ duyệt" / "Đang trao đổi" / "Xong" KHÔNG tính là im; thẻ CHỜ CHỦ (owner_hold / blocked owner|permission / waiting_owner) ở Đang làm cũng KHÔNG (#834).
 */
import { pmName } from './common.mjs';
import { normName } from './staff-logic.mjs';
import { parseAt } from './watch-filter.mjs';

export const IDLE_ASK_MS = 60 * 60_000;
export const IDLE_PM_MS = 120 * 60_000;
export const LOST_MS = 10 * 60_000;
export const WAKE_REPEAT_MS = 10 * 60_000;
export const HOUR_MS = 60 * 60_000;
export const WATCHED_COLUMNS = ['Đang làm', 'Đã giao'];

const colName = (columns, id) => (columns ?? []).find((c) => Number(c.id) === Number(id))?.name ?? null;
const labelsOf = (t) => { const v = t?.labels; if (Array.isArray(v)) return v.map(String); try { const j = JSON.parse(v || '[]'); return Array.isArray(j) ? j.map(String) : []; } catch { return []; } };

/** Nhân viên cầm thẻ: ưu tiên staff.task.task_id == thẻ, sau đó nhãn "@Tên" khớp tên (chuẩn hoá). null nếu không rõ. */
export function holderOf(task, staff) {
  const id = Number(task?.id);
  const byTask = (staff ?? []).find((s) => Number(s.task?.task_id) === id);
  if (byTask) return byTask;
  const names = new Set(labelsOf(task).filter((l) => l.startsWith('@')).map((l) => normName(l.slice(1))));
  return (staff ?? []).find((s) => names.has(normName(s.name))) ?? null;
}

/** Thẻ cần biết giờ bình luận cuối? (thuộc cột canh + hoạt động board > 60') — để chỉ tải task_get cho vài thẻ nghi im. */
export function needsCommentCheck(task, columns, now = Date.now()) {
  if (!WATCHED_COLUMNS.includes(colName(columns, task.column_id))) return false;
  const t = Math.max(parseAt(task.updated_at, 0), parseAt(task.entered_column_at, 0));
  return now - t > IDLE_ASK_MS;
}

/** Mốc hoạt động cuối của thẻ (ms): lớn nhất của updated_at, entered_column_at, bình luận cuối. */
export function lastActivity(task, lastCommentAt) {
  return Math.max(parseAt(task.updated_at, 0), parseAt(task.entered_column_at, 0), parseAt(lastCommentAt, 0));
}

/**
 * #834: thẻ đang CHỜ CHỦ (một phần hay cả thẻ) ⇒ KHÔNG tính là im. Dựa vào DỮ LIỆU, không dò chuỗi bình luận:
 * work_state.owner_hold (cờ #818) · work_state.blocked = owner|permission · người cầm ở trạng thái waiting_owner.
 */
export function isOwnerWait(task, workState, holder) {
  const ws = workState ?? task?.work_state ?? null;
  if (ws?.owner_hold && (ws.owner_hold.waiting || ws.owner_hold.kind)) return true;
  if (ws && ['owner', 'permission'].includes(String(ws.blocked ?? ''))) return true;
  return String(holder?.state ?? '') === 'waiting_owner' && Number(holder?.task?.task_id) === Number(task?.id);
}

const due = (nudged, id, kind, every, now) => { const t = nudged?.[`${id}:${kind}`]; return !(t != null && now - t < every); };

/**
 * tasks/columns: board.data · staff: staff_list.staff · lastComment: {<id>: 'YYYY-MM-DD HH:mm:ss'} (chỉ thẻ đã tải) ·
 * nudged: {"<id>:<kind>": ms} lần cuối đã báo · now.
 * ⇒ [{kind, task, title, who, session, idleMin, text}] (wake trước, rồi theo số thẻ).
 */
export function planSweep({ tasks, columns, staff, lastComment = {}, workStates = {}, nudged = {}, now = Date.now() }) {
  const out = [];
  const holding = new Map(); // tên → [thẻ] đang cầm ở cột canh
  for (const t of tasks ?? []) {
    if (t.deleted_at || t.archived) continue;
    const col = colName(columns, t.column_id);
    if (!WATCHED_COLUMNS.includes(col)) continue;
    const h = holderOf(t, staff);
    if (!h) continue; // thẻ chưa có người cầm: việc của PM, không phải của thư ký
    const who = h.name;
    holding.set(who, [...(holding.get(who) ?? []), t.id]);
    const session = h.runtime?.session_ref ?? null;
    const base = { task: t.id, title: String(t.title ?? '').slice(0, 70), who, session };
    if (!session) { if (due(nudged, t.id, 'nosess', HOUR_MS, now)) out.push({ ...base, kind: 'nosess', text: `${who} cầm #${t.id} nhưng không có phiên (runtime.session_ref) ⇒ không đánh thức được` }); continue; }
    if (col === 'Đã giao' && (h.state === 'assigned_unacked' || h.ack_overdue) && due(nudged, t.id, 'wake', WAKE_REPEAT_MS, now)) {
      out.push({ ...base, kind: 'wake', text: `Thẻ #${t.id} đã giao cho bạn (${base.title}). Đọc \`dbio staff card ${t.id} --full\` rồi nhận thẻ.` });
    }
    const waitOwner = isOwnerWait(t, workStates[t.id], h); // #834: chờ chủ ⇒ không im ⇒ không HỎI / BÁO PM
    const idle = waitOwner ? 0 : now - lastActivity(t, lastComment[t.id]);
    const idleMin = Math.round(idle / 60_000);
    if (idle > IDLE_PM_MS && due(nudged, t.id, 'pm', 2 * HOUR_MS, now)) out.push({ ...base, idleMin, kind: 'pm', text: `#${t.id} im ${idleMin}p (${who}) — @${pmName()} xem có cần can thiệp` });
    else if (idle > IDLE_ASK_MS && idle <= IDLE_PM_MS && due(nudged, t.id, 'ask', HOUR_MS, now)) out.push({ ...base, idleMin, kind: 'ask', text: `thẻ #${t.id} im > 1 giờ: đang LÀM hay đang CHỜ gì? ghi 1 dòng lên thẻ` });
    if (col === 'Đang làm') {
      const seen = parseAt(h.last_seen_at, NaN);
      if (!Number.isNaN(seen) && now - seen > LOST_MS && due(nudged, t.id, 'lost', HOUR_MS, now)) out.push({ ...base, kind: 'lost', text: `#${t.id}: ${who} mất nhịp trực ${Math.round((now - seen) / 60_000)}p (phiên không báo nhịp)` });
    }
  }
  for (const [who, ids] of holding) {
    if (ids.length >= 2 && due(nudged, ids[0], 'double', 2 * HOUR_MS, now)) out.push({ kind: 'double', task: ids[0], title: '', who, session: null, text: `${who} cầm ${ids.length} thẻ (${ids.map((i) => `#${i}`).join(', ')}) — luật: một phiên một thẻ ⇒ báo PM` });
  }
  const order = { wake: 0, ask: 1, lost: 2, pm: 3, nosess: 4, double: 5 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.task - b.task);
}

/** Ghi nhớ đã báo (để 1 lần / khung giờ). Dọn mục > 6 giờ. */
export function markNudged(nudged, actions, now = Date.now()) {
  const out = {};
  for (const [k, v] of Object.entries(nudged ?? {})) if (now - v < 6 * HOUR_MS) out[k] = v;
  for (const a of actions) out[`${a.task}:${a.kind}`] = now;
  return out;
}

const KIND_VI = { wake: 'ĐÁNH THỨC', ask: 'HỎI', pm: 'BÁO PM', lost: 'MẤT NHỊP', nosess: 'KHÔNG PHIÊN', double: '2 THẺ' };
/** ⇒ dòng ngắn cho thư ký: `LOẠI #thẻ · tên → phiên | nội dung`. */
export function formatAction(a) {
  const to = a.session ? ` → ${a.session}` : '';
  return `${KIND_VI[a.kind]} #${a.task}${a.who ? ` · ${a.who}` : ''}${to} | ${a.text}`;
}

/* ---------- dbio staff next (#745 phần 3) ---------- */
const PRIO = { urgent: 4, high: 3, medium: 2, low: 1 };
const prioOf = (p) => (typeof p === 'number' ? p : PRIO[String(p).toLowerCase()] ?? 0);

/**
 * Thẻ kế tiếp ĐÃ GIAO cho tôi: cột "Đã giao", nhãn @tôi, ưu tiên cao trước, cũ trước (entered_column_at, rồi id).
 * ⇒ {next: task|null, queue: [task] (sau next), doing: [task] đang làm dở của tôi (cột Đang làm)}.
 */
export function pickNext({ tasks, columns, meName }) {
  const me = normName(meName);
  const mine = (t) => !t.deleted_at && !t.archived && labelsOf(t).some((l) => l.startsWith('@') && normName(l.slice(1)) === me);
  const inCol = (name) => (tasks ?? []).filter((t) => mine(t) && colName(columns, t.column_id) === name);
  const queue = inCol('Đã giao').sort((a, b) => prioOf(b.priority) - prioOf(a.priority) || parseAt(a.entered_column_at, 0) - parseAt(b.entered_column_at, 0) || a.id - b.id);
  return { next: queue[0] ?? null, queue: queue.slice(1), doing: inCol('Đang làm') };
}

/** ⇒ 1 dòng: `#id [ưu tiên] tiêu đề` (+ còn n thẻ / đang làm dở) hoặc 'hết việc'. */
export function formatNext(r) {
  const doing = r.doing.map((t) => `#${t.id}`).join(',');
  if (!r.next) return `hết việc${doing ? ` — nhưng đang làm dở ${doing}` : ''}`;
  const extra = [r.queue.length && `còn ${r.queue.length} thẻ chờ`, doing && `⚠️ đang làm dở ${doing} (xong thẻ đó trước)`].filter(Boolean).join(' · ');
  return `#${r.next.id} [${r.next.priority}] ${String(r.next.title).slice(0, 90)}${extra ? ` · ${extra}` : ''}`;
}
