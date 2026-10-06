/**
 * lib/watch-fetch.mjs — lấy tin cho `dbio staff watch` (KHÔNG IO ngoài hàm `ai` được truyền vào ⇒ test bằng hàm giả).
 * Chạy được với CẢ máy chủ cũ và mới:
 *   MỚI  staff_pulse.unread.ids = 20 tin chưa đọc MỚI nhất; staff_inbox nhận `ids: number[]` (≤100) ⇒ trả đúng các tin đó.
 *   CŨ   staff_pulse.unread.ids = cửa sổ 50 tin CŨ nhất; staff_inbox bỏ qua `ids` ⇒ trả 50 tin chưa đọc cũ nhất.
 */
import { parseAt } from './watch-filter.mjs';

export const PAGE = 50;

/**
 * Lấy chi tiết đúng các tin `ids` (vừa thấy trong pulse).
 * Gọi staff_inbox {ids}; nếu phản hồi thiếu id nào VÀ không giống phản hồi biết lọc theo ids (có tin ngoài danh sách ⇒ máy chủ cũ trả cửa sổ mặc định)
 * thì lấy thêm cửa sổ mặc định như trước đây. ⇒ {items (chỉ id được hỏi, không trùng), who, missing: [id], fallback: bool}
 */
export async function fetchFreshItems(ai, who, ids) {
  const want = [...new Set((ids ?? []).map(Number).filter(Number.isFinite))];
  const got = new Map();
  let meta = null; let fallback = false;
  const take = (r) => { meta = meta ?? r?.who ?? null; for (const e of r?.items ?? []) if (want.includes(Number(e.id)) && !got.has(Number(e.id))) got.set(Number(e.id), e); };
  for (let i = 0; i < want.length; i += PAGE) {
    const chunk = want.slice(i, i + PAGE);
    const r = await ai('staff_inbox', { who, unread_only: true, limit: PAGE, ids: chunk });
    take(r);
    const returned = (r?.items ?? []).map((e) => Number(e.id));
    const idsAware = returned.length > 0 && returned.every((x) => chunk.includes(x));
    if (!idsAware && chunk.some((x) => !got.has(x))) { // máy chủ cũ bỏ qua ids ⇒ cửa sổ mặc định (đúng như trước)
      fallback = true;
      take(await ai('staff_inbox', { who, unread_only: true, limit: PAGE }));
    }
  }
  return { items: want.filter((x) => got.has(x)).map((x) => got.get(x)), who: meta, missing: want.filter((x) => !got.has(x)), fallback };
}

/**
 * `watch --fresh`: tự ack MỌI tin chưa đọc tạo trước `startMs` (không báo cáo). Đọc từng trang 50 tin cũ nhất (order asc), ack theo trang,
 * dừng khi gặp tin mới hơn mốc (asc ⇒ phần còn lại đều mới) / hết tin / không tiến triển. ⇒ {ids: [đã ack], error?: string}
 */
export async function ackStale(ai, who, startMs, { maxPages = 40 } = {}) {
  const ids = []; const tried = new Set();
  try {
    for (let page = 0; page < maxPages; page++) {
      const r = await ai('staff_inbox', { who, unread_only: true, limit: PAGE, order: 'asc' });
      const items = r?.items ?? [];
      const old = items.filter((e) => !tried.has(e.id) && parseAt(e.at, 0) <= startMs);
      if (!old.length) break;
      const batch = old.map((e) => e.id);
      await ai('staff_inbox_ack', { who, ids: batch });
      for (const id of batch) { tried.add(id); ids.push(id); }
      if (old.length < items.length || items.length < PAGE) break;
    }
  } catch (e) { return { ids, error: e?.message ?? String(e) }; }
  return { ids };
}
