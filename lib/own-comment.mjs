/**
 * lib/own-comment.mjs — #872 R3: tin @nhắc/bản sao sinh từ bình luận do CHÍNH MÌNH viết (vd trưởng nhóm @nhắc người khác ⇒ bản sao dội về trưởng nhóm) KHÔNG được đánh thức mình.
 * Máy chủ không điền người gửi vào khung sự kiện (from = {user_id, character_id:null}) và người viết có thể dùng thẳng công cụ MCP (không qua CLI ⇒ sổ outbox trống),
 * nên tra ĐÚNG bình luận: task_board comment_list ⇒ comment.id == ref_id ⇒ author_staff_id == id của mình. Không tra được ⇒ giữ tin (thức như cũ).
 */
const KINDS = new Set(['mention']);

/** call(tool, args) = client(name).call. ⇒ async (item, selfId) => 'self-comment' | null. Nhớ danh sách bình luận 3 giây / thẻ (bình luận mới nhất có thể vừa tạo). */
export function makeOwnCommentCheck(call, { now = () => Date.now(), as } = {}) {
  const memo = new Map();
  return async (item, selfId) => {
    if (!item || selfId == null || item.ref_id == null || !KINDS.has(String(item.kind))) return null;
    const m = /^(\d+)#(\d+)$/.exec(String(item.task ?? '')); if (!m) return null;
    const find = (list) => (list ?? []).find((c) => Number(c.id) === Number(item.ref_id));
    let hit = memo.get(item.task); let c = hit && now() - hit.ts < 3000 ? find(hit.list) : null;
    if (!c) {
      try {
        const r = await call('task_board', { action: 'comment_list', ...(as ? { as } : {}), profile_id: Number(m[1]), task_id: Number(m[2]), limit: 200 });
        memo.set(item.task, { ts: now(), list: r.comments ?? [] }); c = find(r.comments);
      } catch { return null; }
    }
    return c && c.author_staff_id != null && Number(c.author_staff_id) === Number(selfId) ? 'self-comment' : null;
  };
}
