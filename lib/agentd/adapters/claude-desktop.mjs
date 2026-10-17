/**
 * adapter claude-desktop — phiên chạy trong ỨNG DỤNG Claude (tab Code). Ứng dụng lưu mỗi phiên là `local_<uuid>.json` kèm `cliSessionId` + `cwd`
 * (…/Claude/claude-code-sessions/<tài khoản>/<tổ chức>/local_*.json). Adapter dò `session` (local_… hoặc chính cliSessionId) ⇒ chạy `claude --resume <cliSessionId> -p`
 * ⇒ tin được nối vào CÙNG hội thoại; ứng dụng hiện lại khi mở/làm mới phiên. Kết quả thử trên máy thật: xem README mục "Phiên Desktop".
 *
 * #1082 (chủ 17/10): claude_desktop = nhân viên riêng, chủ theo dõi tận mắt (browser app / điều khiển máy) ⇒ adapter này CHỈ gửi vào ĐÚNG phiên ghim.
 * KHÔNG còn nhánh "phiên ghim trống/mất/quá ngưỡng ⇒ tự tạo phiên CLI ngầm" (#1022 nhánh 3) — việc headless là của adapter claude-cli (nhân viên claude_cli):
 *   - phiên ghim TRỐNG (vừa clear) ⇒ {relay:true}: daemon cầu thư ký nhắn vào phiên (ứng dụng hiện) như luật #872;
 *   - phiên ghim MẤT (không khai session / không thấy tệp) hoặc QUÁ NGƯỠNG không dọn được ⇒ {ok:false, lost:true, red:true}: daemon báo KẸT --kind pm "mất phiên ghim", không tự thay.
 * entry: { allowed_tools (mảng/chuỗi ⇒ --allowedTools), session: 'local_<uuid>' | '<cliSessionId>', cwd (mặc định lấy từ tệp phiên), bin, args, sessions_dir (đổi chỗ tìm, test) }
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionsRoot } from '../../sessions-dir.mjs';
import { contextGuard, findTranscript } from '../context-size.mjs';
import { SAFE_SESSION, allowedToolsArgs, outputArgs, runChild } from './util.mjs';

export const sessionsDirs = (env = process.env, plat = process.platform) => {
  // Windows MSIX: tiến trình NGOÀI gói (Task Scheduler) KHÔNG thấy %APPDATA%\Claude ảo ⇒ thử đường dẫn THẬT trong Packages\Claude_* trước (lib/sessions-dir.mjs, #815)
  if (env === process.env && plat === process.platform) { const r = sessionsRoot(); if (r) return [r]; }
  if (plat === 'win32') return [join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions')];
  if (plat === 'darwin') return [join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')];
  return [join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude', 'claude-code-sessions')];
};

/**
 * local_<uuid> ⇒ {cliSessionId, cwd, title, blank} (duyệt tối đa 3 cấp thư mục); không thấy tệp ⇒ null.
 * Tệp có mà KHÔNG có cliSessionId ⇒ {cliSessionId: null, blank: true, cwd} (phiên vừa clear) — KHÔNG phải "không thấy".
 */
export function resolveDesktopSession(session, dirs = sessionsDirs()) {
  const want = String(session);
  const walk = (d, depth) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isFile() && e.name === `${want}.json`) {
        try { const j = JSON.parse(readFileSync(p, 'utf8')); const id = j.cliSessionId ? String(j.cliSessionId) : null; return { cliSessionId: id, blank: !id, cwd: j.cwd ?? null, title: j.title ?? null, lastActivityAt: Number(j.lastActivityAt) || null }; } catch { /* hỏng */ }
      } else if (e.isDirectory() && depth < 3) { const r = walk(p, depth + 1); if (r) return r; }
    }
    return null;
  };
  for (const d of dirs) if (existsSync(d)) { const r = walk(d, 0); if (r) return r; }
  return null;
}

/** Lấy session_id từ đầu ra JSON của `claude -p --output-format json` (để ghi log); không có ⇒ null. */
export const sessionIdFromOutput = (out) => { const m = /"session_id"\s*:\s*"([A-Za-z0-9_.:-]+)"/.exec(String(out ?? '')); return m ? m[1] : null; };

/** Phiên trống (vừa clear)? Dùng để daemon bỏ qua việc chờ `listen`/hạn gia hạn: không ai đang xử lý gì. */
export function isBlank(entry, dirs) {
  if (!entry?.session || !String(entry.session).startsWith('local_')) return false;
  return !!resolveDesktopSession(entry.session, entry.sessions_dir ? [entry.sessions_dir] : dirs)?.blank;
}

/** Kết quả "mất phiên ghim" — red ⇒ daemon tính thất bại ≥3 ngay và báo KẸT --kind pm; lost ⇒ KHÔNG bao giờ rơi xuống phiên headless. */
export const lostPin = (staff, why) => ({ ok: false, lost: true, red: true, detail: `${staff}: MẤT PHIÊN GHIM — ${why}; claude_desktop không tự thay bằng phiên CLI (cần PM)` });

export default {
  name: 'claude-desktop',
  spawns: false, // #1082: không tự tạo phiên; trống ⇒ cầu thư ký, mất ⇒ KẸT pm
  claims: true, // vẫn chạy tiến trình claude --resume ⇒ chọn tài khoản + claim Run + trackRun như adapter khác
  isBlank: (entry) => isBlank(entry),
  /** Bao lâu (ms) kể từ lần cuối tệp hội thoại của phiên được ghi; không biết ⇒ null. Phiên đang làm việc thì liên tục ghi. */
  activeAgoMs(entry) {
    try {
      if (!entry?.session) return null; let id = String(entry.session); let app = null; // app = lastActivityAt của ứng dụng (cập nhật cả khi lượt đang chạy công cụ lâu, tệp hội thoại chưa kịp ghi)
      if (id.startsWith('local_')) { const r = resolveDesktopSession(id, entry.sessions_dir ? [entry.sessions_dir] : undefined); if (r?.lastActivityAt) app = Date.now() - r.lastActivityAt; if (!r?.cliSessionId) return app; id = r.cliSessionId; }
      const f = findTranscript(id, entry.projects_dir); const t = f ? Date.now() - statSync(f).mtimeMs : null;
      return t == null ? app : app == null ? t : Math.min(t, app);
    } catch { return null; }
  },
  /** #965: phiên có vượt ngưỡng ngữ cảnh? ⇒ {blocked, tokens, max} (phiên trống / không đọc được ⇒ blocked:false). Daemon dùng để TỰ DỌN (cầu thư ký clear) thay vì đứng chờ người. */
  overLimit(entry) {
    try {
      if (!entry?.session) return { blocked: false }; let id = String(entry.session);
      if (id.startsWith('local_')) { const r = resolveDesktopSession(id, entry.sessions_dir ? [entry.sessions_dir] : undefined); if (!r?.cliSessionId) return { blocked: false }; id = r.cliSessionId; }
      return SAFE_SESSION.test(id) ? contextGuard(id, entry, { root: entry.projects_dir }) : { blocked: false };
    } catch { return { blocked: false }; }
  },
  async wake({ staff, entry, prompt, timeoutS, spawnFn }) {
    if (!entry.session) return lostPin(staff, 'chưa khai session_ref (phiên ghim)');
    let toolArgs; try { toolArgs = allowedToolsArgs(entry.allowed_tools); } catch (e) { return { ok: false, detail: `${staff}: ${e.message}` }; }
    let id = String(entry.session); let cwd = entry.cwd ?? null;
    if (id.startsWith('local_')) {
      const r = resolveDesktopSession(id, entry.sessions_dir ? [entry.sessions_dir] : undefined);
      if (!r) return lostPin(staff, `không thấy phiên ${id} trong thư mục phiên của ứng dụng`);
      if (r.blank) return { ok: false, relay: true, detail: `${staff}: phiên ghim vừa clear — cần cầu qua thư ký nhắn vào phiên (không tạo phiên ngầm)` };
      cwd = cwd ?? r.cwd ?? null; id = r.cliSessionId;
    }
    if (!SAFE_SESSION.test(id)) return lostPin(staff, '"session" không hợp lệ');
    { const g = contextGuard(id, entry, { root: entry.projects_dir }); if (g.blocked) return { ok: false, blocked: true, lost: true, red: true, detail: `${staff}: MẤT PHIÊN GHIM (quá ngưỡng) — phiên ~${Math.round(g.tokens / 1000)}k token > ${Math.round(g.max / 1000)}k; claude_desktop không tự thay bằng phiên CLI (cần clear phiên ghim / PM), hoặc đặt allow_large: true` }; }
    const args = ['--resume', id, '-p', ...outputArgs(entry), ...(entry.args ?? []).map(String)];
    return runChild({ bin: entry.bin || 'claude', args, toolArgs, input: prompt, cwd, timeoutS, logName: staff, spawnFn });
  },
};
