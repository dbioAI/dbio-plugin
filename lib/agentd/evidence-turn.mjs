/**
 * lib/agentd/evidence-turn.mjs — #1089: agentd tự thu chứng cứ G3 CUỐI MỖI LƯỢT (không phụ thuộc model nhớ gõ lệnh).
 *  - đầu lượt: ghi HEAD của kho nhân viên làm attempt_base (baseSha);
 *  - cuối lượt: collectAndSend (repo_sha · scope_diff · record · attempt_base) bằng khoá MÁY + vá work_state {run_id, attempt_base}.
 * Mọi lỗi ⇒ trả {error}, không ném: chứng cứ là phụ trợ, không làm hỏng việc đóng Run.
 */
import { collectAndSend, collectGit } from '../evidence.mjs';
import { machineCall } from './roster.mjs';

/** HEAD đầy đủ của kho tại cwd lúc bắt đầu lượt; không ở trong repo ⇒ null. */
export function baseSha(cwd, collect = collectGit) { try { return cwd ? (collect(cwd)?.head ?? null) : null; } catch { return null; } }

/**
 * run = {run_id, card:'board#id', base_sha?}; client = makeClient(name) (có init/tb) | null; mk = khoá máy | null; mcall = machineCall (test thay được).
 * ⇒ {sent[], failed[], skipped?, patched:boolean, error?}
 */
export async function turnEndEvidence({ run, name, cwd, mk, client = null, mcall = machineCall, collect = collectGit }) {
  const m = /^(\d+)#(\d+)$/.exec(String(run?.card ?? '')); if (!m) return { sent: [], failed: [], skipped: 'no_card', patched: false };
  const [board, card] = [Number(m[1]), Number(m[2])];
  try {
    const facts = cwd ? collect(cwd, undefined, undefined, run.base_sha || null) : null;
    const call = mk ? (a) => mcall(mk, 'task_board', { action: 'evidence_add', ...a }) : null;
    const res = await collectAndSend({ board, card, dir: cwd, call, facts, attemptBase: run.base_sha || null, author: name, runId: run.run_id });
    // vá work_state: giữ nguyên trường cũ, thêm run_id + attempt_base (checkpoint thay cả khối ⇒ phải đọc-gộp-ghi)
    let patched = false;
    if (client && facts) {
      try {
        await client.init();
        const prev = (await client.tb('task_get', { task_id: card, comments: 0, body_max: 0, description_max: 0 }))?.task?.work_state ?? {};
        const next = { ...prev, run_id: run.run_id, attempt_base: run.base_sha || prev.attempt_base || facts.base || null };
        delete next.at; delete next.by;
        if (prev.run_id !== next.run_id || prev.attempt_base !== next.attempt_base) { await client.tb('checkpoint', { task_id: card, work_state: next }); patched = true; }
      } catch { /* server cũ / mạng: bỏ qua */ }
    }
    return { ...res, patched };
  } catch (e) { return { sent: [], failed: [], patched: false, error: String(e?.message ?? e).slice(0, 200) }; }
}
