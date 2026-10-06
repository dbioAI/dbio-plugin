/**
 * adapter command — chạy LỆNH TUỲ CHỈNH (mảng, không qua shell của bạn): entry.command = ["node","wake.mjs"] (+ entry.args).
 * Lời nhắc ở stdin; biến môi trường: DBIO_WAKE_STAFF · DBIO_WAKE_PROMPT (≤ 4000 ký tự) · DBIO_WAKE_EVENTS (JSON gọn). Thoát 0 = đã đánh thức.
 */
import { runChild } from './util.mjs';

export default {
  name: 'command',
  async wake({ staff, entry, prompt, events = [], timeoutS, spawnFn }) {
    const cmd = Array.isArray(entry.command) ? entry.command.map(String) : null;
    if (!cmd?.length) return { ok: false, detail: `${staff}: thiếu "command" (mảng: ["lệnh","tham số"…])` };
    const env = { DBIO_WAKE_STAFF: staff, DBIO_WAKE_PROMPT: prompt.slice(0, 4000), DBIO_WAKE_EVENTS: JSON.stringify(events.map((e) => ({ id: e.id, kind: e.kind, task: e.task }))) };
    return runChild({ bin: cmd[0], args: [...cmd.slice(1), ...(entry.args ?? []).map(String)], input: prompt, cwd: entry.cwd, env, timeoutS, logName: staff, spawnFn });
  },
};
