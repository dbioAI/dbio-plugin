/**
 * lib/agentd/run-push.mjs — đẩy Run lên máy chủ (#1036 phần B): MCP task_board `run_record` → một dòng task_attempts (không bảng mới).
 * Hàng đợi bền trên đĩa (outbox.json cạnh sổ Run): mất mạng / máy chủ lỗi ⇒ thử lại có lùi dần; đã ghi ⇒ xoá. Idempotent theo run_id nên thử lại an toàn.
 * Số đo thiếu ⇒ VẮNG khoá (không 0). account = NHÃN (không email).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_RE } from './runs.mjs';

const PERMANENT = new Set(['PARAMS_INVALID', 'NOT_FOUND', 'JOB_CARD']);
const MAX_TRIES = 12;
const backoffMs = (n) => Math.min(30_000 * 2 ** Math.max(0, n - 1), 30 * 60_000);

/** Email ⇒ nhãn tài khoản (phần trước @). Không có ⇒ undefined. */
export const accountLabel = (email) => { const m = /^([^@\s]{1,60})@/.exec(String(email ?? '')); return m ? m[1] : undefined; };

const OUTCOMES = new Set(['ok', 'error', 'timeout', 'spawn_failed', 'lost']);
const iso = (t) => (Number.isFinite(Number(t)) && t ? new Date(Number(t)).toISOString() : undefined);
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/** Bản ghi Run (runs.mjs) ⇒ tham số `run_record`. Đang chạy (chưa ended_at) ⇒ KHÔNG outcome. Thẻ không hợp lệ ⇒ null. */
export function runToRecord(r, { label = accountLabel(r.account), runner } = {}) {
  if (!r || !CARD_RE.test(String(r.card ?? ''))) return null;
  const [board, task] = String(r.card).split('#').map(Number);
  const t = r.tokens ?? null;
  const done = !!r.ended_at;
  const outcome = !done ? undefined : OUTCOMES.has(r.outcome) ? r.outcome : 'error';
  const detail = !done || r.outcome === 'ok' ? undefined : (OUTCOMES.has(r.outcome) ? (r.error_code ?? undefined) : String(r.outcome ?? 'error')).slice(0, 120) || undefined;
  const usage = drop({
    input_tokens: t?.input, output_tokens: t?.output, cache_read_tokens: t?.cache_read, cache_write_tokens: t?.cache_write,
    seconds: done && Number.isFinite(r.duration_ms) ? Math.round(r.duration_ms / 100) / 10 : undefined,
    model: (r.models?.[0]?.model ?? r.model_requested) || undefined, engine: r.engine || undefined, account: label,
    machine: r.machine || undefined, pid: Number.isInteger(r.pid) && r.pid >= 0 ? r.pid : undefined, session_ref: r.session_id || undefined,
    lease_gen: Number.isInteger(r.lease_gen) ? r.lease_gen : undefined, exit_code: Number.isInteger(r.exit_code) ? r.exit_code : undefined,
  });
  return { board, task, args: drop({ profile_id: board, task_id: task, run_id: r.run_id, outcome, status_detail: detail, runner: runner ?? `${r.staff}@${r.machine}`.slice(0, 120), started_at: iso(r.started_at), finished_at: done ? iso(r.ended_at) : undefined, usage }) };
}

export function createRunPusher({ dir, now = () => Date.now(), call, log = () => {} }) {
  const file = join(dir, 'outbox.json');
  const read = () => { try { const j = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } };
  const write = (a) => { try { mkdirSync(dir, { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(a)); renameSync(`${file}.tmp`, file); } catch { /* bỏ */ } };
  let busy = false;
  return {
    pending: () => read().length,
    /** Xếp một bản ghi (đang chạy hoặc kết thúc). Cùng run_id đang chờ ⇒ bản mới thay (kết thúc thắng bản đang chạy). */
    enqueue(staff, rec) {
      if (!rec) return;
      const q = read().filter((x) => x.args.run_id !== rec.args.run_id);
      q.push({ seq: `${now()}-${Math.random().toString(36).slice(2, 8)}`, staff, args: rec.args, tries: 0, next_at: 0 });
      write(q);
    },
    /** Gửi những bản đến hạn; lỗi tạm ⇒ lùi dần; lỗi vĩnh viễn / quá lượt ⇒ bỏ + log. ⇒ {sent, dropped, left} */
    async flush() {
      if (busy) return { sent: 0, dropped: 0, left: read().length };
      busy = true; let sent = 0; let dropped = 0;
      try {
        const q = read(); const keep = [];
        for (const it of q) {
          if (it.next_at > now()) { keep.push(it); continue; }
          try { await call(it.staff, it.args); sent++; }
          catch (e) {
            it.tries++;
            if (e?.auth || PERMANENT.has(e?.code) || it.tries >= MAX_TRIES) { dropped++; log(`${it.staff}: bỏ đẩy Run ${String(it.args.run_id).slice(0, 8)} thẻ ${it.args.profile_id}#${it.args.task_id} — ${e?.message ?? e}`); continue; }
            it.next_at = now() + backoffMs(it.tries); keep.push(it);
          }
        }
        // bản mới xếp trong lúc đang gửi (enqueue ghi đè tệp) không được mất: gộp lại theo run_id
        const cur = read(); const handled = new Set(q.map((x) => x.seq));
        for (const x of cur) if (!handled.has(x.seq)) { const i = keep.findIndex((k) => k.args.run_id === x.args.run_id); if (i >= 0) keep.splice(i, 1); keep.push(x); }
        write(keep);
      } finally { busy = false; }
      return { sent, dropped, left: read().length };
    },
  };
}
