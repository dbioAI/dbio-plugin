/**
 * adapter claude-desktop — phiên chạy trong ỨNG DỤNG Claude (tab Code). Ứng dụng lưu mỗi phiên là `local_<uuid>.json` kèm `cliSessionId` + `cwd`
 * (…/Claude/claude-code-sessions/<tài khoản>/<tổ chức>/local_*.json). Adapter dò `session` (local_… hoặc chính cliSessionId) ⇒ chạy `claude --resume <cliSessionId> -p`
 * ⇒ tin được nối vào CÙNG hội thoại; ứng dụng hiện lại khi mở/làm mới phiên. Kết quả thử trên máy thật: xem README mục "Phiên Desktop".
 * entry: { session: 'local_<uuid>' | '<cliSessionId>', cwd (mặc định lấy từ tệp phiên), bin, args, sessions_dir (đổi chỗ tìm, test) }
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contextGuard } from '../context-size.mjs';
import { SAFE_SESSION, runChild } from './util.mjs';

export const sessionsDirs = (env = process.env, plat = process.platform) => {
  if (plat === 'win32') return [join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions')];
  if (plat === 'darwin') return [join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')];
  return [join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude', 'claude-code-sessions')];
};

/** local_<uuid> ⇒ {cliSessionId, cwd} (duyệt tối đa 3 cấp thư mục); không thấy ⇒ null. */
export function resolveDesktopSession(session, dirs = sessionsDirs()) {
  const want = String(session);
  const walk = (d, depth) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isFile() && e.name === `${want}.json`) { try { const j = JSON.parse(readFileSync(p, 'utf8')); if (j.cliSessionId) return { cliSessionId: String(j.cliSessionId), cwd: j.cwd ?? null, title: j.title ?? null }; } catch { /* hỏng */ } }
      else if (e.isDirectory() && depth < 3) { const r = walk(p, depth + 1); if (r) return r; }
    }
    return null;
  };
  for (const d of dirs) if (existsSync(d)) { const r = walk(d, 0); if (r) return r; }
  return null;
}

export default {
  name: 'claude-desktop',
  async wake({ staff, entry, prompt, timeoutS, spawnFn }) {
    if (!entry.session) return { ok: false, detail: `${staff}: thiếu "session" (local_<uuid> của phiên trong ứng dụng)` };
    let id = String(entry.session); let cwd = entry.cwd ?? null;
    if (id.startsWith('local_')) {
      const r = resolveDesktopSession(id, entry.sessions_dir ? [entry.sessions_dir] : undefined);
      if (!r) return { ok: false, detail: `${staff}: không thấy phiên ${id} trong thư mục phiên của ứng dụng` };
      id = r.cliSessionId; cwd = cwd ?? r.cwd;
    }
    if (!SAFE_SESSION.test(id)) return { ok: false, detail: `${staff}: "session" không hợp lệ` };
    { const g = contextGuard(id, entry, { root: entry.projects_dir }); if (g.blocked) return { ok: false, blocked: true, detail: `${staff}: phiên ~${Math.round(g.tokens / 1000)}k token > ${Math.round(g.max / 1000)}k — thức lượt đầu sẽ rất tốn (cache nguội); chờ listen/thư ký, hoặc đặt allow_large: true` }; }
    const args = ['--resume', id, '-p', ...(entry.args ?? []).map(String)];
    return runChild({ bin: entry.bin || 'claude', args, input: prompt, cwd, timeoutS, logName: staff, spawnFn });
  },
};
