/**
 * lib/watch-state.mjs — trạng thái cục bộ cho `dbio staff watch` (IO mỏng, ngoài repo: %USERPROFILE%\.dbio\).
 *   staff-keys\<tên>.seen.json     tin/trao đổi đã biết (không lấy lại)
 *   staff-keys\<tên>.queue.json    {queue, recent} hàng đợi tin THƯỜNG đang gom + bộ nhớ chống trùng
 *   staff-keys\<tên>.touched.json  {<taskId>: ms} thẻ tôi vừa move/done/assign (cho lọc `decision` dội lại)
 *   staff-keys\<tên>.assigned.json {<taskId>: ms} thẻ tôi vừa GIAO (`staff assign`) — lọc mention/assign dội lại ≤ 2 phút
 *   staff-keys<tên>.alive.json    {pid, started, beat, every, ended?} nhịp sống của watch đang chạy (cho `dbio hr roster` cột "đang canh?")
 *   watch-log.jsonl                mỗi lần watch thoát 1 dòng (cho `dbio usage`); biến DBIO_WATCH_LOG đổi đường dẫn
 * Lỗi đọc/ghi ⇒ lặng lẽ bỏ qua (đây chỉ là tối ưu, không được làm hỏng lệnh chính).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { internalRoot, keyFile } from './common.mjs';
import { DEFAULT_SECRETARIES, touch } from './watch-filter.mjs';

const side = (name, ext) => keyFile(name).replace(/\.json$/, `.${ext}.json`);
const readJson = (f, dflt) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : dflt; } catch { return dflt; } };
const writeJson = (f, v) => { try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v)); } catch { /* bỏ */ } };

export const watchLogFile = () => process.env.DBIO_WATCH_LOG || join(homedir(), '.dbio', 'watch-log.jsonl');

export const loadSeen = (name) => new Set(readJson(side(name, 'seen'), []));
export const saveSeen = (name, set) => writeJson(side(name, 'seen'), [...set].slice(-500));
export const loadQueue = (name) => { const q = readJson(side(name, 'queue'), {}); return { queue: Array.isArray(q.queue) ? q.queue : [], recent: q.recent && typeof q.recent === 'object' ? q.recent : {} }; };
export const saveQueue = (name, q) => writeJson(side(name, 'queue'), q);
export const loadTouched = (name) => readJson(side(name, 'touched'), {});
export const loadAssigned = (name) => readJson(side(name, 'assigned'), {});

/** Ghi nhận tôi vừa đụng thẻ `taskId` (gọi sau move/done/assign thành công). */
export function recordTouch(name, taskId) { writeJson(side(name, 'touched'), touch(loadTouched(name), taskId)); }

/** Ghi nhận tôi vừa GIAO thẻ `taskId` (chỉ `staff assign`); đồng thời ghi vào touched. */
export function recordAssign(name, taskId) { writeJson(side(name, 'assigned'), touch(loadAssigned(name), taskId)); recordTouch(name, taskId); }

/** Nhịp sống của watch (ghi mỗi vòng; `every` = ms dự kiến ngủ ⇒ roster biết khi nào coi là chết). `ended` = đã thoát bình thường. */
export function recordBeat(name, patch = {}) {
  const prev = readJson(side(name, 'alive'), {});
  const base = prev.ended || !prev.started ? { pid: process.pid, started: Date.now() } : prev;
  writeJson(side(name, 'alive'), { ...base, ended: false, ...patch, beat: Date.now() });
}
export function endBeat(name) { writeJson(side(name, 'alive'), { ...readJson(side(name, 'alive'), {}), ended: true, beat: Date.now() }); }
export const readBeat = (name) => readJson(side(name, 'alive'), null);

/** Danh sách tên thư ký: config/watch.json {"secretaries": [...]}, thiếu ⇒ mặc định. */
export function loadSecretaries() {
  const j = readJson(internalRoot() ? join(internalRoot(), 'config', 'watch.json') : join(homedir(), '.dbio', 'watch.json'), {});
  return Array.isArray(j.secretaries) && j.secretaries.length ? j.secretaries.map(String) : DEFAULT_SECRETARIES;
}

export function logWatchExit(entry) {
  try { const f = watchLogFile(); mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`); } catch { /* bỏ */ }
}

export function readWatchLog() {
  try {
    const f = watchLogFile();
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Thư ký: lần cuối đã báo từng việc quét sổ cái {"<thẻ>:<loại>": ms} — `dbio staff sweep` / watch của thư ký (#745). Biến DBIO_NUDGED đổi đường dẫn. */
export const nudgedFile = () => process.env.DBIO_NUDGED || join(homedir(), '.dbio', 'secretary-nudged.json');
export const loadNudged = () => readJson(nudgedFile(), {});
export const saveNudged = (v) => writeJson(nudgedFile(), v);
