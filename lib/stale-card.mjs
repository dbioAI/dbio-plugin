/**
 * lib/stale-card.mjs — #872 nợ 4: phiên mới / vừa clear bị đánh thức bởi BACKLOG nhắc cũ của thẻ đã Xong hoặc đã xoá.
 * `--fresh` chỉ bỏ tin trước lúc nối; tin chưa ack cũ vẫn tới. Luật: tin CŨ (> minAgeMs) trên thẻ đã Xong / không còn ⇒ coi là rác ⇒ bỏ + ack, không thức.
 * Tin còn MỚI (vd "mở lại giúp") và tin giao việc (assign) KHÔNG bị chạm. Không đọc được thẻ ⇒ giữ tin (thức như cũ).
 */
export const STALE_AGE_MS = 30 * 60_000;
const DONE_COL = /^(xong|done|hoàn thành|hoan thanh)$/i;
const GONE = /^(NOT_FOUND|TASK_NOT_FOUND)$/i; // chỉ tin MÃ lỗi, không khớp chuỗi tự do (lỗi tạm 404/cổng ≠ thẻ đã xoá)
const SKIP_KINDS = new Set(['assign', 'owner_assign', 'owner_reply', 'decision', 'ping']);

/** call(tool, args) = client(name).call. ⇒ async (item) => 'card-done' | 'card-gone' | null. Nhớ kết quả 2 phút / thẻ. */
export function makeStaleCheck(call, { now = () => Date.now(), minAgeMs = STALE_AGE_MS, as } = {}) {
  const memo = new Map();
  return async (item) => {
    if (!item || SKIP_KINDS.has(String(item.kind))) return null;
    const m = /^(\d+)#(\d+)$/.exec(String(item.task ?? '')); if (!m) return null;
    const at = Date.parse(item.at ?? ''); if (!Number.isFinite(at) || now() - at < minAgeMs) return null;
    const hit = memo.get(item.task); if (hit && now() - hit.ts < 120_000) return hit.v;
    let v = null;
    try {
      const t = (await call('task_board', { action: 'task_get', ...(as ? { as } : {}), profile_id: Number(m[1]), task_id: Number(m[2]), comments: 0, body_max: 0, description_max: 0 })).task;
      if (t && DONE_COL.test(String(t.column?.name ?? '').trim())) v = 'card-done';
    } catch (e) { v = GONE.test(String(e?.code ?? '')) ? 'card-gone' : null; }
    memo.set(item.task, { ts: now(), v });
    return v;
  };
}
