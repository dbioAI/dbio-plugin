/**
 * lib/agentd/lease.mjs — LEASE tài nguyên dùng chung CẢ MÁY (#1036): "Chrome thật" chỉ MỘT worker dùng tại một thời điểm, các worker khác chờ hoặc làm việc khác.
 * Một tệp / tài nguyên: <dir>/<tài nguyên>.json {holder, run_id, pid, gen, acquired_at, renewed_at, expires_at, released}.
 * gen = số FENCING tăng đơn điệu mỗi lần đổi chủ (kể cả sau khi nhả — giữ "bia mộ"): thao tác gia hạn/nhả mang sai gen ⇒ bị từ chối (LEASE_LOST) thay vì ghi đè chủ mới.
 * Lease hết hạn (không gia hạn) hoặc pid chủ đã mất ⇒ người sau chiếm được, gen+1. Mọi thay đổi qua khoá thư mục ngắn (mkdir nguyên tử) ⇒ không hai bên cùng thắng.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pidAlive } from './runs.mjs';

export const leaseDir = () => process.env.DBIO_AGENTD_LEASE_DIR || join(homedir(), '.dbio', 'agentd-leases');
export const RESOURCES = Object.freeze(['browser']);
export const DEFAULT_TTL_S = 300;
const safe = (r) => { const n = String(r ?? ''); if (!/^[a-z][a-z0-9_-]{0,31}$/.test(n)) throw new Error(`tài nguyên không hợp lệ: ${JSON.stringify(n.slice(0, 20))}`); return n; };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function createLeases({ dir = leaseDir(), now = () => Date.now() } = {}) {
  const fileOf = (res) => join(dir, `${safe(res)}.json`);
  const read = (res) => { try { const j = JSON.parse(readFileSync(fileOf(res), 'utf8')); return j && typeof j === 'object' ? j : null; } catch { return null; } };
  const write = (res, rec) => { const f = fileOf(res); writeFileSync(`${f}.tmp`, JSON.stringify(rec)); renameSync(`${f}.tmp`, f); };
  /** Khoá ngắn quanh đọc-sửa-ghi. Khoá treo > 10s (tiến trình chết giữa chừng) bị phá. */
  function locked(res, fn) {
    mkdirSync(dir, { recursive: true }); const lock = `${fileOf(res)}.lock`; const t0 = Date.now();
    for (;;) {
      try { mkdirSync(lock); break; } catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        try { if (Date.now() - statSync(lock).mtimeMs > 10_000) { rmdirSync(lock); continue; } } catch { /* vừa được nhả */ }
        if (Date.now() - t0 > 5000) throw new Error('lease: không lấy được khoá tệp (5s)');
        sleepSync(10);
      }
    }
    try { return fn(); } finally { try { rmdirSync(lock); } catch { /* bỏ */ } }
  }
  const expired = (rec, t) => !rec || rec.released || t >= Number(rec.expires_at ?? 0) || (rec.pid != null && !pidAlive(rec.pid));
  const view = (rec, t) => (rec ? { ...rec, held: !expired(rec, t), remaining_s: expired(rec, t) ? 0 : Math.round((rec.expires_at - t) / 1000) } : null);
  return {
    dir,
    /** ⇒ {ok:true, gen, expires_at} | {ok:false, holder, remaining_s, gen}. Chủ hiện tại xin lại ⇒ gia hạn (cùng gen). */
    acquire(res, { holder, run_id = null, pid = null, ttl_s = DEFAULT_TTL_S }) {
      if (!holder) throw new Error('lease: thiếu holder');
      return locked(res, () => {
        const t = now(); const cur = read(res);
        if (!expired(cur, t) && cur.holder !== holder) return { ok: false, holder: cur.holder, run_id: cur.run_id ?? null, remaining_s: Math.round((cur.expires_at - t) / 1000), gen: cur.gen };
        const same = !expired(cur, t) && cur.holder === holder;
        const rec = { holder, run_id, pid, gen: same ? cur.gen : Number(cur?.gen ?? 0) + 1, acquired_at: same ? cur.acquired_at : t, renewed_at: t, expires_at: t + ttl_s * 1000, released: false };
        write(res, rec); return { ok: true, gen: rec.gen, expires_at: rec.expires_at, takeover: !!cur && !cur.released && !same };
      });
    },
    /** Gia hạn: phải đúng holder + gen. Sai ⇒ {ok:false, lost:true} (LEASE_LOST). */
    renew(res, { holder, gen, ttl_s = DEFAULT_TTL_S }) {
      return locked(res, () => {
        const t = now(); const cur = read(res);
        if (!cur || cur.released || cur.holder !== holder || Number(cur.gen) !== Number(gen) || t >= cur.expires_at) return { ok: false, lost: true, holder: cur && !expired(cur, t) ? cur.holder : null };
        write(res, { ...cur, renewed_at: t, expires_at: t + ttl_s * 1000 }); return { ok: true, gen: cur.gen, expires_at: t + ttl_s * 1000 };
      });
    },
    /** Nhả: đúng holder (+gen nếu có). Giữ bia mộ để gen không tụt. Nhả lease không phải của mình ⇒ không làm gì. */
    release(res, { holder, gen = null }) {
      return locked(res, () => {
        const cur = read(res); if (!cur || cur.released || cur.holder !== holder || (gen != null && Number(cur.gen) !== Number(gen))) return { ok: false, released: false };
        write(res, { gen: cur.gen, released: true, released_at: now(), holder: cur.holder, expires_at: 0 }); return { ok: true, released: true };
      });
    },
    /** Daemon: nhả lease của run đã kết thúc / chủ không còn run nào sống (holder = tên nhân viên). */
    releaseIf(res, pred) {
      return locked(res, () => { const cur = read(res); if (!cur || cur.released || !pred(cur)) return false; write(res, { gen: cur.gen, released: true, released_at: now(), holder: cur.holder, expires_at: 0, reason: 'owner_run_ended' }); return true; });
    },
    status(res) { return view(read(res), now()); },
    all() { return RESOURCES.map((r) => ({ resource: r, ...(this.status(r) ?? { held: false, gen: 0 }) })); },
    exists: (res) => existsSync(fileOf(res)),
  };
}
