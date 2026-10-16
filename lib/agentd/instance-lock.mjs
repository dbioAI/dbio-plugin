/** #1060 (c): MỘT daemon / máy. 16/10 hai daemon (wrapper cũ + pm2) cùng chạy ⇒ mỗi @mention mở 2 Run. Khoá = tệp pid + nhịp status còn tươi (bắt cả daemon bản cũ không biết khoá). */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pidAlive } from './runs.mjs';

export const lockFile = () => process.env.DBIO_AGENTD_LOCK || join(homedir(), '.dbio', 'agentd.lock');

/** ⇒ {ok:true} đã giữ khoá | {ok:false, owner:pid}. statusRead() trả status.json (hoặc null); beat tươi < freshMs ⇒ chủ khác đang sống. */
export function acquireInstanceLock({ self = process.pid, file = lockFile(), statusRead = () => null, now = Date.now(), freshMs = 90_000, alive = pidAlive } = {}) {
  const st = statusRead();
  if (st?.pid && st.pid !== self && alive(st.pid) && now - Number(st.beat ?? 0) < freshMs) return { ok: false, owner: st.pid };
  let cur = null; try { cur = Number(readFileSync(file, 'utf8').trim()) || null; } catch { /* chưa có */ }
  if (cur && cur !== self && alive(cur)) return { ok: false, owner: cur };
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, String(self)); } catch { /* sổ phụ: không chặn */ }
  return { ok: true };
}

export function releaseInstanceLock({ self = process.pid, file = lockFile() } = {}) {
  try { if (Number(readFileSync(file, 'utf8').trim()) === self) unlinkSync(file); } catch { /* bỏ */ }
}
