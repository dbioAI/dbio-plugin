/**
 * lib/stream/dropped.mjs — SỔ TIN BỊ LỌC (#1094): mỗi tin kênh `staff:` bị bỏ + tự ack (approved/touched/gop-y/owner-wait/stale…) ghi 1 dòng vào
 * ~/.dbio/stream/<tên>.<consumer>.dropped.jsonl để `dbio-staff listen --catchup` đọc lại tin bỏ lỡ (bộ lọc sai thì người duyệt vẫn thấy).
 * Không ghi tin vô nghĩa để xem lại (self/self-ref/copy/dup/assigned = nhiễu của chính mình). Lỗi đĩa ⇒ lặng lẽ bỏ. Giữ ≤ MAX_LINES dòng gần nhất.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { streamDir } from './cursor.mjs';

export const MAX_LINES = 400;
export const NOISE_REASONS = new Set(['self', 'self-ref', 'self-comment', 'copy', 'dup', 'assigned']);
const safe = (s) => String(s).replace(/[^\p{L}\p{N}_-]/gu, '_');
export const droppedFile = (name, consumer) => join(streamDir(), `${safe(name)}.${safe(consumer)}.dropped.jsonl`);

/** drops = [{item, reason}] ⇒ ghi các tin đáng xem lại. */
export function appendDropped(name, consumer, drops, now = Date.now()) {
  const rows = (drops ?? []).filter((d) => d?.item && !NOISE_REASONS.has(String(d.reason)));
  if (!rows.length) return 0;
  try {
    mkdirSync(streamDir(), { recursive: true });
    const f = droppedFile(name, consumer);
    appendFileSync(f, rows.map((d) => JSON.stringify({ at: new Date(now).toISOString(), id: d.item.id ?? null, task: d.item.task ?? null, kind: d.item.kind ?? null, reason: d.reason, text: String(d.item.text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) })).join('\n') + '\n');
    const all = readFileSync(f, 'utf8').split('\n').filter(Boolean);
    if (all.length > MAX_LINES * 1.25) writeFileSync(f, all.slice(-MAX_LINES).join('\n') + '\n');
    return rows.length;
  } catch { return 0; }
}

/** ⇒ [{at,id,task,kind,reason,text}] trong `hours` giờ gần nhất và (tuỳ chọn) id > afterId, cũ → mới. */
export function readDropped(name, consumer, { hours = 24, afterId = null, now = Date.now() } = {}) {
  let lines = [];
  try { lines = readFileSync(droppedFile(name, consumer), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const cut = now - hours * 3_600_000;
  const out = [];
  for (const l of lines) {
    try { const r = JSON.parse(l); if (Date.parse(r.at) >= cut && (afterId == null || Number(r.id) > Number(afterId))) out.push(r); } catch { /* dòng hỏng */ }
  }
  return out;
}
