/**
 * lib/agentd/adapters/util.mjs — chạy tiến trình con AN TOÀN cho adapter: lời nhắc đi qua STDIN (không bao giờ nằm trên dòng lệnh / qua shell),
 * mọi tham số phải khớp danh sách ký tự an toàn (Windows .cmd cần shell ⇒ không để lọt ký tự đặc biệt).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export const SAFE_ARG = /^[\p{L}\p{N}_.:=@/\\+-]+$/u;
/** --allowedTools: mỗi mục `Tool` hoặc `Tool(mẫu)`; mẫu cho phép ( ) * : khoảng trắng, KHÔNG có dấu nháy kép, %, ^, &, |, <, >, ;, $, backtick ⇒ an toàn khi bọc "…" qua cmd.exe. */
export const SAFE_TOOL = /^[A-Za-z0-9_]+(?:[(][A-Za-z0-9_.:*@/ -]*[)])?$/; // (không cho '\' — đường dẫn Windows dùng '/')
export const UNSAFE_TOOLARG = new RegExp('["%^&|<>;$`' + String.fromCharCode(10, 13) + ']');
export const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/; // không '-' đầu, không '=' ⇒ dữ liệu từ máy chủ không thành cờ lệnh
/**
 * Tên trần (claude, codex) ⇒ ĐƯỜNG DẪN TUYỆT ĐỐI dò trong PATH — KHÔNG bao giờ dò thư mục hiện hành (Windows: cmd.exe ưu tiên cwd ⇒ claude.cmd trong thư mục dự án chạy thay claude thật).
 * Không thấy ⇒ trả nguyên tên (spawn báo lỗi rõ). Có dấu phân cách đường dẫn ⇒ giữ nguyên.
 */
export function resolveBin(bin, env = process.env, plat = process.platform) {
  if (isAbsolute(bin) || /[\\/]/.test(bin)) return bin;
  const exts = plat === 'win32' ? ['', ...String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const dirs = String(env.PATH ?? env.Path ?? '').split(plat === 'win32' ? ';' : delimiter).filter((d) => d && d !== '.');
  for (const d of dirs) for (const e of exts) { const f = join(d, bin + e); try { if (existsSync(f) && statSync(f).isFile()) return f; } catch { /* bỏ */ } }
  return bin;
}
export const assertSafeArgs = (args) => { for (const a of args) if (!SAFE_ARG.test(String(a))) throw new Error(`tham số không an toàn: ${JSON.stringify(String(a).slice(0, 40))}`); };
/** allowed_tools (mảng hoặc chuỗi phẩy) ⇒ ['--allowedTools', 'a,b'] hoặc []; mục sai ⇒ ném. */
export function allowedToolsArgs(v) {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(/,(?![^(]*[)])/)).map((x) => String(x).trim()).filter(Boolean);
  for (const t of list) if (!SAFE_TOOL.test(t)) throw new Error(`allowed_tools không hợp lệ: ${JSON.stringify(t.slice(0, 40))}`);
  return list.length ? ['--allowedTools', list.join(',')] : [];
}
export const logFile = (name) => join(process.env.DBIO_AGENTD_LOG_DIR || join(homedir(), '.dbio', 'agentd-logs'), `${String(name).replace(/[^\p{L}\p{N}_-]/gu, '_')}.log`);

/**
 * Chạy `bin args…`, ghi `input` vào stdin, gom stdout/stderr vào tệp log (≤ 8KB cuối trong kết quả). Không bao giờ ném: lỗi ⇒ {ok:false, detail}.
 * ⇒ {ok, detail, running: Promise<{code}>} — `ok` trả NGAY khi tiến trình khởi động được; `running` xong khi tiến trình thoát (daemon dùng để không chồng 2 lượt lên 1 phiên).
 */
/** Windows: kill() chỉ giết cmd.exe bọc ngoài ⇒ dùng taskkill /T để diệt cả cây. */
function killTree(child, win) { try { if (win && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else child.kill(); } catch { /* bỏ */ } }

export function runChild({ bin, args = [], toolArgs = [], input = '', cwd, env, timeoutS = 900, logName, spawnFn = spawn }) {
  try { assertSafeArgs(args); } catch (e) { return { ok: false, detail: e.message }; }
  if (toolArgs.length && (toolArgs.length !== 2 || toolArgs[0] !== '--allowedTools' || UNSAFE_TOOLARG.test(toolArgs[1]))) return { ok: false, detail: 'toolArgs không hợp lệ' };
  let child;
  const win = process.platform === 'win32';
  bin = resolveBin(bin);
  const shell = win && !/\.exe$/i.test(bin); // .cmd/.bat/tên trần (npm shim: claude.cmd) cần shell; .exe chạy thẳng ⇒ kill đúng tiến trình
  const spawnArgs = [...args, ...(toolArgs.length ? [toolArgs[0], shell ? `"${toolArgs[1]}"` : toolArgs[1]] : [])];
  const exe = shell && /\s/.test(bin) && !bin.startsWith('"') ? `"${bin}"` : bin;
  try { child = spawnFn(exe, spawnArgs, { cwd: cwd || undefined, env: { ...process.env, ...(env ?? {}), NoDefaultCurrentDirectoryInExePath: '1', DBIO_AGENTD_TURN: '1' }, stdio: ['pipe', 'pipe', 'pipe'], shell, windowsHide: true }); } catch (e) { return { ok: false, detail: `không chạy được ${bin}: ${e.message}` }; }
  const lf = logFile(logName ?? bin);
  try { mkdirSync(dirname(lf), { recursive: true }); } catch { /* bỏ */ }
  const tail = [];
  const sink = (b) => { tail.push(String(b)); try { appendFileSync(lf, b); } catch { /* bỏ */ } };
  child.stdout?.on('data', sink); child.stderr?.on('data', sink);
  child.stdin?.on('error', () => {});
  try { child.stdin?.end(input); } catch { /* bỏ */ }
  const timer = setTimeout(() => { killTree(child, win) }, timeoutS * 1000); timer.unref?.();
  const running = new Promise((res) => {
    child.on('error', (e) => { clearTimeout(timer); res({ code: -1, error: e.message, out: tail.join('').slice(-8192) }); });
    child.on('close', (code) => { clearTimeout(timer); res({ code, out: tail.join('').slice(-8192) }); });
  });
  return { ok: true, detail: `đã chạy ${bin} (pid ${child.pid ?? '?'})`, running };
}
