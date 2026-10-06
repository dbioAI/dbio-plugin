/**
 * lib/stream/cursor.mjs — con trỏ kênh `staff:` lưu ở đĩa (ngoài repo: ~/.dbio/stream/). MỖI người tiêu thụ (listen / agentd) một tệp riêng ⇒ không giẫm nhau.
 * Lỗi đọc/ghi ⇒ lặng lẽ bỏ qua (null ⇒ nối không `since` = nhận tin chưa đọc, vẫn không sót).
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const streamDir = () => process.env.DBIO_STREAM_DIR || join(homedir(), '.dbio', 'stream');
const safe = (s) => String(s).replace(/[^\p{L}\p{N}_-]/gu, '_');
export const cursorFile = (name, consumer) => join(streamDir(), `${safe(name)}.${safe(consumer)}.cursor.json`);

export function loadCursor(name, consumer, host = '') {
  try { const j = JSON.parse(readFileSync(cursorFile(name, consumer), 'utf8')); return j.host === host && Number.isInteger(j.cursor) ? j.cursor : null; } catch { return null; }
}
export function saveCursor(name, consumer, host, cursor) {
  try { mkdirSync(streamDir(), { recursive: true }); const f = cursorFile(name, consumer); writeFileSync(`${f}.tmp`, JSON.stringify({ host, cursor, at: new Date().toISOString() })); renameSync(`${f}.tmp`, f); } catch { /* bỏ */ }
}
