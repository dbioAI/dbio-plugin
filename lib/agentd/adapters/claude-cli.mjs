/**
 * adapter claude-cli — đánh thức phiên Claude Code bằng `claude --resume <session> -p` (lời nhắc qua stdin).
 * entry: { allowed_tools: ['Bash(dbio-staff:*)'] hoặc chuỗi 'a,b' (⇒ --allowedTools; không đi qua SAFE_ARG vì có ( ) * :), session (bắt buộc, id phiên claude), cwd, bin ('claude'), args: ['--permission-mode','…'] (tuỳ chọn), model }
 * Phiên đang mở trong ứng dụng/terminal khác: Claude Code ghi nối vào cùng tệp hội thoại — xem ghi chú ở adapter claude-desktop.
 */
import { contextGuard } from '../context-size.mjs';
import { SAFE_SESSION, allowedToolsArgs, runChild } from './util.mjs';

export default {
  name: 'claude-cli',
  async wake({ staff, entry, prompt, timeoutS, spawnFn }) {
    if (!entry.session) return { ok: false, detail: `${staff}: thiếu "session" (id phiên claude)` };
    if (!SAFE_SESSION.test(String(entry.session))) return { ok: false, detail: `${staff}: "session" không hợp lệ` };
    { const g = contextGuard(String(entry.session), entry, { root: entry.projects_dir }); if (g.blocked) return { ok: false, blocked: true, detail: `${staff}: phiên ~${Math.round(g.tokens / 1000)}k token > ${Math.round(g.max / 1000)}k — thức lượt đầu sẽ rất tốn (cache nguội); chờ listen/thư ký, hoặc đặt allow_large: true` }; }
    const args = ['--resume', String(entry.session), '-p', ...(entry.model ? ['--model', String(entry.model)] : []), ...(entry.args ?? []).map(String)];
    let toolArgs; try { toolArgs = allowedToolsArgs(entry.allowed_tools); } catch (e) { return { ok: false, detail: `${staff}: ${e.message}` }; }
    return runChild({ bin: entry.bin || 'claude', args, toolArgs, input: prompt, cwd: entry.cwd, timeoutS, logName: staff, spawnFn });
  },
};
