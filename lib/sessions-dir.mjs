/**
 * lib/sessions-dir.mjs — thư mục phiên của app Claude desktop (claude-code-sessions), dùng chung cho hr / check (#815).
 * Windows: app cài dạng MSIX ⇒ dữ liệu THẬT nằm ở %LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude; tiến trình CHẠY TRONG app thấy nó
 * qua đường dẫn ảo %APPDATA%\\Claude, còn tiến trình NGOÀI gói (Task Scheduler) thì KHÔNG ⇒ phải thử đường dẫn thật trước.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Danh sách thư mục gốc "Claude" để thử, theo thứ tự ưu tiên (hàm thuần theo tham số, có test). */
export function sessionBaseCandidates({ platform = process.platform, env = process.env, home = homedir(), ls = (d) => { try { return readdirSync(d); } catch { return []; } } } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const pkgs = ls(join(local, 'Packages')).filter((n) => /^Claude_/i.test(n)).map((n) => join(local, 'Packages', n, 'LocalCache', 'Roaming', 'Claude'));
    return [...pkgs, env.APPDATA && join(env.APPDATA, 'Claude'), join(home, 'AppData', 'Roaming', 'Claude')].filter(Boolean);
  }
  if (platform === 'darwin') return [join(home, 'Library', 'Application Support', 'Claude')];
  return [join(home, '.config', 'Claude')];
}

/** Thư mục claude-code-sessions đầu tiên TỒN TẠI, không có ⇒ null. */
export function sessionsRoot(opts = {}) {
  const exists = opts.exists ?? existsSync;
  for (const base of sessionBaseCandidates(opts)) { const r = join(base, 'claude-code-sessions'); if (exists(r)) return r; }
  return null;
}

const HEAD_BYTES = 4096;
const str = (head, key) => { const m = new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")').exec(head); if (!m) return undefined; try { return JSON.parse(m[1]); } catch { return undefined; } };
const raw = (head, key) => new RegExp('"' + key + '"\\s*:\\s*([^,}\\s]+)').exec(head)?.[1];

/**
 * Siêu dữ liệu phiên từ NỬA ĐẦU tệp local_*.json (title/model/isArchived/id/lastActivityAt nằm trong ~600 byte đầu; cả tệp ~460KB).
 * Lý do (#815): tiến trình NGOÀI gói MSIX đọc từng tệp 460KB chậm tới ~1,5s ⇒ cả lượt nhịp nền >5 phút. Không thấy title trong phần đầu ⇒ đọc cả tệp.
 * Trả {id, title, model, at, archived} hoặc null nếu hỏng.
 */
export function readSessionMeta(file, { read = (f, n) => { const fd = openSync(f, 'r'); try { const b = Buffer.alloc(n); const got = readSync(fd, b, 0, n, 0); return b.toString('utf8', 0, got); } finally { closeSync(fd); } }, readAll = (f) => readFileSync(f, 'utf8') } = {}) {
  try {
    let head = read(file, HEAD_BYTES);
    let title = str(head, 'title');
    if (title === undefined) { head = readAll(file); title = str(head, 'title'); }
    if (!title) return null;
    return { id: str(head, 'sessionId'), cli: str(head, 'cliSessionId'), title, model: str(head, 'model'), at: Number(str(head, 'lastActivityAt') ?? raw(head, 'lastActivityAt')) || 0, archived: raw(head, 'isArchived') === 'true' };
  } catch { return null; }
}
