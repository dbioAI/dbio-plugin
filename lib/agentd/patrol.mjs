/**
 * lib/agentd/patrol.mjs — TUẦN TRA của agentd (#1079): agentd (tổ trưởng máy) TỰ kiểm và TỰ đẩy việc của nhân viên trên máy — PM/chủ không quét tay.
 * Toàn hàm THUẦN (test được, không IO). Daemon nối: job `patrol` 5' ⇒ planCards / backoffMs; idle-watchdog ⇒ idleVerdict; kênh điếc ⇒ deafVerdict.
 * Mọi mốc là cấu hình (defaults.patrol_*), mặc định ghi dưới.
 */
import { isOwnerWait, pickNext } from '../secretary.mjs';

export const PATROL_DEFAULTS = Object.freeze({
  patrol_claim_min: 10,        // Đã giao quá ngần này phút mà chưa có Run ⇒ tự mở lượt (claim)
  patrol_idle_warn_min: 10,    // Run sống mà không có hoạt động ngần này phút ⇒ ghi cảnh báo lên thẻ
  patrol_idle_kill_min: 20,    // … ngần này phút ⇒ dừng tiến trình (theo pid) để tuần tra mở lượt mới
  patrol_deaf_min: 10,         // kênh đóng 4002 quá ngần này phút ⇒ cảnh báo thẻ + dựng lại kênh
  patrol_backoff_base_s: 30,   // lỗi mạng khi quét: 30s → ×2 … trần 5'
  patrol_backoff_max_s: 300,
});
export const patrolCfg = (cfg) => ({ ...PATROL_DEFAULTS, ...Object.fromEntries(Object.entries(cfg?.defaults ?? {}).filter(([k, v]) => k in PATROL_DEFAULTS && Number.isFinite(Number(v)) && Number(v) >= 0).map(([k, v]) => [k, Number(v)])) });

/** Lỗi liên tiếp thứ n (≥1) ⇒ ms chờ trước lần quét kế: 30s, 60s, 120s, 240s, 300s… */
export const backoffMs = (n, p = PATROL_DEFAULTS) => Math.min(p.patrol_backoff_max_s, p.patrol_backoff_base_s * 2 ** Math.max(0, n - 1)) * 1000;

const tsOf = (v) => { const t = Date.parse(String(v ?? '').includes('T') || /Z$/.test(String(v ?? '')) ? v : String(v ?? '').replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? t : null; };

/**
 * Thẻ của `name` không ai làm. ⇒ [{card, id, kind: 'claim'|'rescue', col, age_min}]
 *  - rescue: thẻ ở Đang làm mà KHÔNG có Run mở (phiên chết/kênh điếc/tiếp quản lỗi).
 *  - claim : thẻ ở Đã giao quá patrol_claim_min mà không có Run mở và NV không đang làm thẻ nào (mỗi NV một thẻ/lượt — chỉ thẻ đầu hàng đợi).
 * openCards = Set "<sổ>#<thẻ>" các Run mở của NV (kể cả đã trả slot — thẻ chờ chủ đã nằm cột khác).
 */
/** #1084: thẻ đang CHỜ PM/chủ (blocked_reason, work_state.blocked/waiting/owner_hold) ⇒ tuần tra không tiếp quản/claim. Thiếu dữ liệu ⇒ false. */
export function isWaitingCard(t) {
  const ws = t?.work_state && typeof t.work_state === 'object' ? t.work_state : null;
  return !!(String(t?.blocked_reason ?? '').trim() || ws?.blocked || ws?.waiting || isOwnerWait(t, ws, null));
}
export const planCards = (a) => scanCards(a).items;
/** Như planCards nhưng kèm `checked` = số thẻ của NV đã kiểm (Đang làm + thẻ đầu Đã giao). */
export function scanCards({ board, tasks, columns, name, openCards, now, p = PATROL_DEFAULTS }) {
  const r = pickNext({ tasks, columns, meName: name }); const out = [];
  const age = (t) => { const at = tsOf(t.entered_column_at) ?? tsOf(t.updated_at); return at == null ? null : Math.max(0, Math.round((now - at) / 60_000)); };
  for (const t of r.doing) { if (isWaitingCard(t)) continue; const card = `${board}#${t.id}`; if (!openCards.has(card)) out.push({ card, id: t.id, kind: 'rescue', col: 'Đang làm', age_min: age(t) }); }
  const busy = r.doing.length > 0 || [...openCards].length > 0;
  if (r.next && !busy) { const a = age(r.next); const card = `${board}#${r.next.id}`; if (a != null && a >= p.patrol_claim_min) out.push({ card, id: r.next.id, kind: 'claim', col: 'Đã giao', age_min: a }); }
  return { items: out, checked: r.doing.length + (r.next ? 1 : 0) };
}

/** Run sống: im bao lâu? ⇒ 'ok' | 'warn' | 'kill'. lastActAt không biết (null) ⇒ 'ok' (không đoán). */
export function idleVerdict({ lastActAt, now, p = PATROL_DEFAULTS }) {
  if (lastActAt == null) return 'ok';
  const m = (now - lastActAt) / 60_000;
  return m >= p.patrol_idle_kill_min ? 'kill' : m >= p.patrol_idle_warn_min ? 'warn' : 'ok';
}

/** Kênh nghe của NV: {channel, channelSince(ms)} ⇒ 'ok' | 'deaf' (đóng 4002/closed quá patrol_deaf_min). */
export function deafVerdict({ channel, channelSince, now, p = PATROL_DEFAULTS }) {
  if (!/^closed/.test(String(channel ?? ''))) return 'ok';
  const since = Number(channelSince); if (!Number.isFinite(since)) return 'ok';
  return (now - since) / 60_000 >= p.patrol_deaf_min ? 'deaf' : 'ok';
}

/** Chọn đúng tiến trình `claude` THẬT của lượt: bỏ shim (cmd/powershell/sh, hoặc node bọc claude) — tức tiến trình có CON cũng khớp --name. procs có {pid, ppid, cmd}. */
export function rootsOnly(named) {
  const parents = new Set((named ?? []).map((x) => x.ppid).filter((v) => v != null));
  return (named ?? []).filter((x) => !parents.has(x.pid) && !/^\s*"?(?:[\w:\\/. -]*[\\/])?(?:cmd|powershell|pwsh|sh|bash)(?:\.exe)?"?\s/i.test(x.cmd));
}
