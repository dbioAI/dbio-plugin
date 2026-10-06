/**
 * adapter codex — đánh thức phiên Codex CLI: `codex exec resume <session> -` (lời nhắc qua stdin). Thiếu session ⇒ `--last` (phiên gần nhất trong cwd).
 * entry: { session, cwd, bin ('codex'), args }
 */
import { SAFE_SESSION, runChild } from './util.mjs';

export default {
  name: 'codex',
  async wake({ staff, entry, prompt, timeoutS, spawnFn }) {
    if (entry.session && !SAFE_SESSION.test(String(entry.session))) return { ok: false, detail: `${staff}: "session" không hợp lệ` };
    const args = ['exec', 'resume', ...(entry.session ? [String(entry.session)] : ['--last']), ...(entry.args ?? []).map(String), '-'];
    return runChild({ bin: entry.bin || 'codex', args, input: prompt, cwd: entry.cwd, timeoutS, logName: staff, spawnFn });
  },
};
