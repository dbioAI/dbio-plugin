/**
 * adapter claude-cli — đánh thức phiên Claude Code bằng `claude --resume <session> -p` (lời nhắc qua stdin).
 * entry: { allowed_tools: ['Bash(dbio-staff:*)'] hoặc chuỗi 'a,b' (⇒ --allowedTools; không đi qua SAFE_ARG vì có ( ) * :), session (bắt buộc, id phiên claude), cwd, bin ('claude'), args: ['--permission-mode','…'] (tuỳ chọn), model }
 * Phiên đang mở trong ứng dụng/terminal khác: Claude Code ghi nối vào cùng tệp hội thoại — xem ghi chú ở adapter claude-desktop.
 */
import { contextGuard, resumeVerdict, DEFAULT_RESUME_MAX_BYTES } from '../context-size.mjs';
import { renderHandoffPrompt } from '../handoff.mjs';
import { SAFE_SESSION, allowedToolsArgs, runChild } from './util.mjs';

export default {
  name: 'claude-cli',
  async wake({ staff, entry, prompt, events, timeoutS, spawnFn, runEnv, handoff = null, prevCard = null, resumeMaxBytes = DEFAULT_RESUME_MAX_BYTES }) {
    if (!entry.session) return { ok: false, detail: `${staff}: thiếu "session" (id phiên claude)` };
    if (!SAFE_SESSION.test(String(entry.session))) return { ok: false, detail: `${staff}: "session" không hợp lệ` };
    // #1044: có phiếu bàn giao + khai cwd ⇒ MẶC ĐỊNH phiên MỚI; --resume chỉ khi cùng thẻ với Run trước VÀ hội thoại < resumeMaxBytes (hoặc entry.allow_large)
    const card = (events ?? []).map((e) => String(e?.task ?? '')).find((t) => /^\d+#\d+$/.test(t)) ?? null;
    const verdict = handoff && entry.cwd && !entry.allow_large ? resumeVerdict({ session: String(entry.session), card, prevCard, maxBytes: resumeMaxBytes, root: entry.projects_dir }) : { ok: true };
    if (!verdict.ok) {
      let toolArgs; try { toolArgs = allowedToolsArgs(entry.allowed_tools); } catch (e) { return { ok: false, detail: `${staff}: ${e.message}` }; }
      const res = runChild({ bin: entry.bin || 'claude', args: ['-p', '--output-format', 'json', ...(entry.model ? ['--model', String(entry.model)] : []), ...(entry.args ?? []).map(String)], toolArgs, input: renderHandoffPrompt(staff, handoff.text, prompt), cwd: entry.cwd, env: runEnv, timeoutS, logName: staff, spawnFn });
      return res.ok ? { ...res, detail: `${res.detail} — không --resume (${verdict.why}): phiên MỚI + phiếu bàn giao`, spawnNew: true, card, handoff_tokens: handoff.tokens, model: entry.model ?? null } : res;
    }
    { const g = contextGuard(String(entry.session), entry, { root: entry.projects_dir }); if (g.blocked) return { ok: false, blocked: true, detail: `${staff}: phiên ~${Math.round(g.tokens / 1000)}k token > ${Math.round(g.max / 1000)}k — thức lượt đầu sẽ rất tốn (cache nguội); chờ listen/thư ký, hoặc đặt allow_large: true` }; }
    const args = ['--resume', String(entry.session), '-p', '--output-format', 'json', ...(entry.model ? ['--model', String(entry.model)] : []), ...(entry.args ?? []).map(String)];
    let toolArgs; try { toolArgs = allowedToolsArgs(entry.allowed_tools); } catch (e) { return { ok: false, detail: `${staff}: ${e.message}` }; }
    const res = runChild({ bin: entry.bin || 'claude', args, toolArgs, input: prompt, cwd: entry.cwd, env: runEnv, timeoutS, logName: staff, spawnFn });
    return res.ok ? { ...res, model: entry.model ?? null } : res;
  },
};
