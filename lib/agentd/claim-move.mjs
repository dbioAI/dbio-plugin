// #1113: claim Run thành công cho thẻ ở "Đã giao" ⇒ agentd chuyển thẻ sang "Đang làm" (không trông vào việc model tự chuyển).
export const DOING_COLUMN = 'Đang làm';

/**
 * c = {tb}. card = "<sổ>#<thẻ>". Chỉ chuyển khi thẻ đang ở cột tên "Đã giao". Lỗi ⇒ log, KHÔNG ném, không chặn lượt.
 * ⇒ 'moved' | 'skip' | 'error'
 */
export async function moveToDoing(c, card, log = () => {}) {
  try {
    const id = Number(String(card).split('#').pop());
    const b = await c.tb('get');
    const t = (b?.data?.tasks ?? []).find((x) => Number(x.id) === id);
    const col = (b?.data?.columns ?? []).find((x) => Number(x.id) === Number(t?.column_id));
    if (!t || !/^đã giao$/i.test(String(col?.name ?? '').trim())) return 'skip';
    await c.tb('task_move', { task_id: id, column_name: DOING_COLUMN });
    log(`chuyển ${card} Đã giao → ${DOING_COLUMN}`);
    return 'moved';
  } catch (e) { log(`chuyển ${card} sang ${DOING_COLUMN} lỗi (không chặn lượt) — ${e?.message ?? e}`); return 'error'; }
}
