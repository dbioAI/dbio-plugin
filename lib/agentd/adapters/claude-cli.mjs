/**
 * adapter claude-cli — đánh thức phiên Claude Code bằng `claude --resume <session> -p` (lời nhắc qua stdin).
 * entry: { allowed_tools: ['Bash(dbio-staff:*)'] hoặc chuỗi 'a,b' (⇒ --allowedTools; không đi qua SAFE_ARG vì có ( ) * :), session (bắt buộc, id phiên claude), cwd, bin ('claude'), args: ['--permission-mode','…'] (tuỳ chọn), model }
 * Phiên đang mở trong ứng dụng/terminal khác: Claude Code ghi nối vào cùng tệp hội thoại — xem ghi chú ở adapter claude-desktop.
 */
import { contextGuard, resumeVerdict, DEFAULT_RESUME_MAX_BYTES } from '../context-size.mjs';
import { renderHandoffPrompt } from '../handoff.mjs';
import { SAFE_ARG, SAFE_SESSION, allowedToolsArgs, outputArgs, runChild } from './util.mjs';

/** Lượt ngầm KHÔNG ai bấm duyệt được ⇒ luôn có --permission-mode (mặc định bypassPermissions khi entry.args không khai) — thiếu cờ ⇒ mọi Edit/Bash bị từ chối (17/10 #1075/#1078/#1079/#1080). */
export const permArgs = (entry) => { const a = (entry?.args ?? []).map(String); return a.some((x) => x === '--permission-mode' || x.startsWith('--permission-mode=')) ? a : ['--permission-mode', 'bypassPermissions', ...a]; };

export default {
  name: 'claude-cli',
  spawns: true, // #1075: có cwd ⇒ tự tạo phiên headless khi chưa khai session (NV từ roster máy chủ) ⇒ daemon đi đường claim/Run có pid như claude-desktop
  spawnsFor: (entry) => !!entry?.cwd || !!entry?.session,
  async wake({ staff, entry, prompt, events, timeoutS, spawnFn, runEnv, handoff = null, prevCard = null, resumeMaxBytes = DEFAULT_RESUME_MAX_BYTES }) {
    if (!entry.session) { // #1075: NV từ roster không có session ⇒ phiên MỚI `claude -p --name` trong cwd + phiếu bàn giao (đủ cờ như claude-desktop: bypass, stream-json); trả {pid, running}
      if (!entry.cwd) return { ok: false, detail: `${staff}: thiếu "session" (id phiên claude) và không có cwd để tự tạo phiên` };
      let toolArgs; try { toolArgs = allowedToolsArgs(entry.allowed_tools); } catch (e) { return { ok: false, detail: `${staff}: ${e.message}` }; }
      const card = (events ?? []).map((e) => String(e?.task ?? '')).find((t) => /^\d+#\d+$/.test(t)) ?? null;
      const nm = `${staff.replace(/[^\p{L}\p{N}_.-]+/gu, '-')}${card ? `-${card.split('#')[1]}` : ''}`;
      const input = handoff ? renderHandoffPrompt(staff, handoff.text, prompt) : prompt;
      const res = runChild({ bin: entry.bin || 'claude', args: ['-p', ...outputArgs(entry), ...(SAFE_ARG.test(nm) ? ['--name', nm] : []), ...(entry.model ? ['--model', String(entry.model)] : []), ...permArgs(entry)], toolArgs, input, cwd: entry.cwd, env: runEnv, timeoutS, logName: staff, spawnFn });
      return res.ok ? { ...res, detail: `${res.detail} — chưa khai session: phiên MỚI${card ? ` cho thẻ ${card}` : ''}`, spawnNew: true, card, handoff_tokens: handoff?.tokens ?? null, model: entry.model ?? null } : res;
    }
    if (!SAFE_SESSION.test(String(entry.session))) return { ok: false, detail: `${staff}: "session" không hợp lệ` };
    // #1044: có phiếu bàn giao + khai cwd ⇒ MẶC ĐỊNH phiên MỚI; --resume chỉ khi cùng thẻ với Run trước VÀ hội thoại < resumeMaxBytes (hoặc entry.allow_large)
    const card = (events ?? []).map((e) => String(e?.task ?? '')).find((t) => /^\d+#\d+$/.test(t)) ?? null;
    const verdict = handoff && entry.cwd && !entry.allow_large ? resumeVerdict({ session: String(entry.session), card, prevCard, maxBytes: resumeMaxBytes, root: entry.projects_dir }) : { ok: true };
    if (!verdict.ok) {
      let toolArgs; try { toolArgs = allowedToolsArgs(entry.allowed_tools); } catch (e) { return { ok: false, detail: `${staff}: ${e.message}` }; }
      const res = runChild({ bin: entry.bin || 'claude', args: ['-p', ...outputArgs(entry), ...(entry.model ? ['--model', String(entry.model)] : []), ...permArgs(entry)], toolArgs, input: renderHandoffPrompt(staff, handoff.text, prompt), cwd: entry.cwd, env: runEnv, timeoutS, logName: staff, spawnFn });
      return res.ok ? { ...res, detail: `${res.detail} — không --resume (${verdict.why}): phiên MỚI + phiếu bàn giao`, spawnNew: true, card, handoff_tokens: handoff.tokens, model: entry.model ?? null } : res;
    }
    { const g = contextGuard(String(entry.session), entry, { root: entry.projects_dir }); if (g.blocked) return { ok: false, blocked: true, detail: `${staff}: phiên ~${Math.round(g.tokens / 1000)}k token > ${Math.round(g.max / 1000)}k — thức lượt đầu sẽ rất tốn (cache nguội); chờ listen/thư ký, hoặc đặt allow_large: true` }; }
    const args = ['--resume', String(entry.session), '-p', ...outputArgs(entry), ...(entry.model ? ['--model', String(entry.model)] : []), ...permArgs(entry)];
    let toolArgs; try { toolArgs = allowedToolsArgs(entry.allowed_tools); } catch (e) { return { ok: false, detail: `${staff}: ${e.message}` }; }
    const res = runChild({ bin: entry.bin || 'claude', args, toolArgs, input: prompt, cwd: entry.cwd, env: runEnv, timeoutS, logName: staff, spawnFn });
    return res.ok ? { ...res, model: entry.model ?? null } : res;
  },
};
