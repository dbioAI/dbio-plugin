/**
 * lib/agentd/workspace.mjs — bọc adapter (#1062 G2) để MỘT lượt có mã chạy an toàn mà KHÔNG sửa daemon:
 *  (2) requires.resources mutate|transact trên repo ⇒ lease `repo-<tên>` 1 lượt mutate / repo (tạm, tới khi worktree ổn; tắt: entry.repo_lease=false) — bận ⇒ HOÃN, không spawn;
 *  (1) worktree RIÊNG của thẻ làm cwd (idempotent, giữ nguyên trạng khi phục hồi) + phiếu bàn giao thêm trạng thái BỀN (sha, file dở) đọc từ git;
 *  (3) claude: hook canh lượt dài (30'/1M) qua `--settings` + env DBIO_TURN_*.
 * Lease nhả khi tiến trình thoát; daemon chết ⇒ lease gắn pid tiến trình con, hết pid ⇒ người sau chiếm được (lease.mjs).
 * Tắt hẳn: entry.workspace=false hoặc DBIO_AGENTD_WORKSPACE=0.
 */
import { createLeases } from './lease.mjs';
import { estTokens } from './handoff.mjs';
import { guardSettingsFile } from './turn-guard.mjs';
import { codeResources, handoffLines, prepareWorktree, repoKey } from './worktree.mjs';

const CARD = /^\d+#\d+$/;
const cardOf = (ctx) => (ctx.events ?? []).map((e) => String(e?.task ?? '')).find((t) => CARD.test(t)) ?? ctx.handoff?.card ?? null;

export function withWorkspace(adapter, deps = {}) {
  return {
    ...adapter, // giữ spawns/spawnsFor/isBlank/… — mất cờ spawns ⇒ daemon không claim/Run ⇒ lost process_gone (17/10)
    name: adapter.name,
    async wake(ctx) {
      const entry = ctx.entry ?? {};
      if (entry.workspace === false || process.env.DBIO_AGENTD_WORKSPACE === '0') return adapter.wake(ctx);
      const card = cardOf(ctx); const leases = deps.leases ?? createLeases(); const prepare = deps.prepare ?? prepareWorktree;
      const repos = card && ctx.handoff ? codeResources(ctx.handoff.requires, { repos: entry.repos, root: deps.root }) : [];
      const holder = ctx.staff; const runId = ctx.runEnv?.DBIO_RUN_ID ?? null; const ttl_s = Number(ctx.timeoutS ?? 14400) + 600;
      const held = []; const releaseAll = () => { for (const h of held.splice(0)) { try { leases.release(h.res, { holder, gen: h.gen }); } catch { /* bỏ */ } } };
      if (entry.repo_lease !== false) {
        for (const r of repos) {
          const res = repoKey('repo', r.name); let a;
          try { a = leases.acquire(res, { holder, run_id: runId, pid: process.pid, ttl_s }); } catch (e) { releaseAll(); return { ok: false, hold: true, detail: `HOÃN: lease ${res} lỗi — ${e.message}` }; }
          if (!a.ok) { releaseAll(); return { ok: false, hold: true, detail: `HOÃN: repo ${r.name} đang có lượt mutate của ${a.holder} (còn ~${Math.round(a.remaining_s / 60)}') — 1 lượt mutate/repo (#1062)` }; }
          held.push({ res, gen: a.gen });
        }
      }
      const wts = [];
      for (const r of repos) {
        const w = prepare({ repo: r, card });
        if (!w.ok) { releaseAll(); return { ok: false, detail: `${ctx.staff}: worktree ${r.name} cho ${card} lỗi — ${w.detail}` }; }
        wts.push({ ...w, repo: r.name });
      }
      let { handoff } = ctx; let nextEntry = entry; let prevCard = ctx.prevCard;
      if (wts.length) {
        nextEntry = { ...entry, cwd: wts[0].path };
        prevCard = null; // cwd đổi sang worktree ⇒ luôn phiên MỚI + phiếu (không --resume hội thoại của cwd khác)
        const text = `${handoff.text}\n${handoffLines(card, wts).join('\n')}`;
        handoff = { ...handoff, text, tokens: estTokens(text) };
      }
      const guard = adapter.name === 'claude-cli' && card && entry.turn_guard !== false ? (deps.guardSettings ?? guardSettingsFile)() : null;
      if (guard) nextEntry = { ...nextEntry, args: [...(nextEntry.args ?? []), '--settings', guard] };
      const tg = entry.turn_guard && typeof entry.turn_guard === 'object' ? entry.turn_guard : {};
      const runEnv = { ...(ctx.runEnv ?? {}), ...(card ? { DBIO_TURN_CARD: card, DBIO_TURN_STAFF: String(ctx.staff), DBIO_TURN_STARTED_AT: String(Date.now()) } : {}), ...(wts.length ? { DBIO_TURN_WORKTREE: wts[0].path } : {}), ...(tg.minutes != null ? { DBIO_TURN_GUARD_MIN: String(tg.minutes) } : {}), ...(tg.cache_read != null ? { DBIO_TURN_GUARD_CACHE: String(tg.cache_read) } : {}) };
      let r;
      try { r = await adapter.wake({ ...ctx, entry: nextEntry, handoff, prevCard, runEnv }); } catch (e) { releaseAll(); throw e; }
      if (!r?.ok || !r.running) { releaseAll(); return r; }
      for (const h of held) { try { const a = leases.acquire(h.res, { holder, run_id: runId, pid: r.pid ?? process.pid, ttl_s }); if (a.ok) h.gen = a.gen; } catch { /* giữ pid daemon */ } } // lease theo pid TIẾN TRÌNH CON
      const running = r.running.finally(releaseAll);
      return { ...r, running, worktrees: wts.map((w) => ({ repo: w.repo, path: w.path, head: w.state?.head ?? null })), ...(wts.length ? { detail: `${r.detail} · worktree ${wts.map((w) => w.path).join(', ')}` } : {}) };
    },
  };
}
