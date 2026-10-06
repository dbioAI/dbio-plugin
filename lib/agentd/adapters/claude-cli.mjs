/**
 * adapter claude-cli — đánh thức phiên Claude Code bằng `claude --resume <session> -p` (lời nhắc qua stdin).
 * entry: { session (bắt buộc, id phiên claude), cwd, bin ('claude'), args: ['--permission-mode','…'] (tuỳ chọn), model }
 * Phiên đang mở trong ứng dụng/terminal khác: Claude Code ghi nối vào cùng tệp hội thoại — xem ghi chú ở adapter claude-desktop.
 */
import { SAFE_SESSION, runChild } from './util.mjs';

export default {
  name: 'claude-cli',
  async wake({ staff, entry, prompt, timeoutS, spawnFn }) {
    if (!entry.session) return { ok: false, detail: `${staff}: thiếu "session" (id phiên claude)` };
    if (!SAFE_SESSION.test(String(entry.session))) return { ok: false, detail: `${staff}: "session" không hợp lệ` };
    const args = ['--resume', String(entry.session), '-p', ...(entry.model ? ['--model', String(entry.model)] : []), ...(entry.args ?? []).map(String)];
    return runChild({ bin: entry.bin || 'claude', args, input: prompt, cwd: entry.cwd, timeoutS, logName: staff, spawnFn });
  },
};
