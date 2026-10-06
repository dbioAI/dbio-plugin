/**
 * lib/secretary-io.mjs — IO mỏng của quét sổ cái cho thư ký (#745 phần 2). Logic thuần ở lib/secretary.mjs (có test).
 * `ai`/`tb` = client MCP của nhân viên chạy lệnh (khoá riêng). KHÔNG ghi gì lên sổ cái, KHÔNG nhắn phiên nào — chỉ trả danh sách việc.
 * Chi phí: 1 staff_list + 1 task_board get + task_get(comments:1) cho từng thẻ nghi im (thường 0–4). 0 token LLM.
 */
import { loadNudged, saveNudged } from './watch-state.mjs';
import { markNudged, needsCommentCheck, planSweep } from './secretary.mjs';

/** ⇒ {actions, scanned, checked}. mark=true ⇒ ghi nhớ đã báo (1 lần / khung giờ); dry ⇒ không ghi nhớ. */
export async function runSweep({ ai, tb, now = Date.now(), mark = true }) {
  const [board, st] = await Promise.all([tb('get'), ai('staff_list', { kind: 'internal' })]);
  const tasks = board.data?.tasks ?? []; const columns = board.data?.columns ?? [];
  const lastComment = {}; const workStates = {};
  const suspects = tasks.filter((t) => !t.deleted_at && needsCommentCheck(t, columns, now));
  await Promise.all(suspects.map(async (t) => {
    try { const g = (await tb('task_get', { task_id: t.id, comments: 1, body_max: 1, description_max: 0 })).task; const r = g?.comments ?? []; const last = r[r.length - 1]; if (last?.at) lastComment[t.id] = last.at; if (g?.work_state) workStates[t.id] = g.work_state; } catch { /* không đọc được bình luận ⇒ dùng mốc board */ }
  }));
  const nudged = loadNudged();
  const actions = planSweep({ tasks, columns, staff: st.staff ?? [], lastComment, workStates, nudged, now });
  if (mark && actions.length) saveNudged(markNudged(nudged, actions, now));
  return { actions, scanned: tasks.length, checked: suspects.length };
}
