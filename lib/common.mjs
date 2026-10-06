/**
 * lib/common.mjs — phần dùng chung của mọi nhóm lệnh `dbio <nhóm> <lệnh>`. Node thuần, không phụ thuộc gói ngoài.
 * Chuẩn: đầu ra ≤3 dòng (`--full` mới in đủ) · `--dry` cho lệnh ghi · không bao giờ in khoá.
 * Mã thoát: 0 ok · 1 lỗi server/đối số · 2 khoá/danh tính sai hoặc thiếu · 3 cần GO/quyền người.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // gốc repo dbio-plugin
/** Gốc kho dbio-internal (chỉ có ở máy dev): do dbio-internal đặt qua DBIO_INTERNAL_ROOT khi gọi lõi này; máy khách không có ⇒ null. */
/** Tên trưởng nhóm để @nhắc: DBIO_PM_NAME (đặt theo workspace), mặc định chữ chung 'PM'. */
export const pmName = () => process.env.DBIO_PM_NAME || 'PM';
export const internalRoot = () => process.env.DBIO_INTERNAL_ROOT || null;

/**
 * Sổ cái (board) của người này — KHÔNG viết cứng. Thứ tự: --board · biến DBIO_BOARD · trường "board" trong tệp khoá · null.
 * null ⇒ client.resolveBoard() hỏi server (thẻ đang cầm của chính nhân viên, staff_list.task.board_id).
 */
export function boardOf(flags = {}, cfg = null, env = process.env) {
  const v = flags.board ?? env.DBIO_BOARD ?? cfg?.board;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Khoá nhân viên có/hỏng/thiếu (không đọc giá trị ra ngoài). */
export function keyState(role, file = keyFile(role)) {
  if (!existsSync(file)) return 'missing';
  try { const c = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); return c?.key && c?.mcp_url ? 'ok' : 'broken'; } catch { return 'broken'; }
}

/** Cờ có giá trị đi kèm; còn lại `--x` là cờ bool. multiFlags: cờ LẶP được ⇒ mảng (vd --out, #738). Trả {flags, pos}. */
export function parseArgs(argv, valueFlags = [], multiFlags = []) {
  const vf = new Set(['--as', '--board', '--model', '--session', ...valueFlags]);
  const mf = new Set(multiFlags);
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (mf.has(a)) (flags[a.slice(2)] ??= []).push(argv[++i]);
    else if (vf.has(a)) flags[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else pos.push(a);
  }
  return { flags, pos };
}

export function die(msg, code = 1) { (code === 0 ? console.log : console.error)(msg); process.exit(code); }

/** Lấy khối chú thích mở đầu tệp làm nội dung `--help`. */
export function helpOf(fileUrl) {
  return readFileSync(new URL(fileUrl), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, '').trimEnd();
}

export const cut = (s, n) => { const t = String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
export const taskId = (v) => { const n = Number(String(v ?? '').replace(/^#/, '').split('#').pop()); if (!Number.isInteger(n) || n <= 0) die('Thiếu/sai mã thẻ.'); return n; };
export const labelsOf = (v) => { if (Array.isArray(v)) return v.map(String); try { const j = JSON.parse(v || '[]'); return Array.isArray(j) ? j.map(String) : []; } catch { return []; } };

/** git chỉ-đọc; lỗi ⇒ chuỗi rỗng. trimEnd (không trim): porcelain mở đầu bằng ' M'. */
export const git = (dir, ...a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd(); } catch { return ''; } };

export function gitFacts(dir) {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (!top) return null;
  const branch = git(top, 'rev-parse', '--abbrev-ref', 'HEAD');
  const head = git(top, 'rev-parse', '--short', 'HEAD');
  const subject = git(top, 'log', '-1', '--format=%s');
  const base = git(top, 'merge-base', 'HEAD', 'origin/main').slice(0, 7);
  const ahead = git(top, 'rev-list', '--count', 'origin/main..HEAD');
  const onRemote = git(top, 'branch', '-r', '--contains', 'HEAD').split('\n').map((s) => s.trim()).filter(Boolean);
  const dirty = git(top, 'status', '--porcelain').split('\n').filter(Boolean);
  return { top, branch, head, subject, base, ahead, onRemote, dirty };
}

/** Khoá riêng nhân viên: %USERPROFILE%\.dbio\staff-keys\<tên>.json — ngoài repo, do quản trị workspace cấp. */
export const keyFile = (name) => join(homedir(), '.dbio', 'staff-keys', `${name.replace(/[^\p{L}\p{N}_-]/gu, '_')}.json`);

/** Tên nhân viên: --as, hoặc biến DBIO_STAFF. */
export function whoAmI(flags) {
  const name = flags.as || process.env.DBIO_STAFF;
  if (!name) die('Thiếu --as "<tên nhân viên>" (hoặc biến DBIO_STAFF).', 2);
  return name;
}

/** Client MCP của MỘT nhân viên; khoá nạp muộn ⇒ lệnh chỉ-đọc cục bộ vẫn chạy khi máy chưa có khoá. */
export function client(name, flags = {}) {
  let cfg = null;
  /** flags.throwAuth ⇒ lỗi khoá NÉM (có .auth) thay vì thoát tiến trình — để lệnh đọc rơi về bản kho (#806). */
  const fail = (msg, code) => { if (flags.throwAuth) { const e = new Error(msg); e.auth = true; throw e; } die(msg, code); };
  const load = () => {
    if (cfg) return cfg;
    const f = keyFile(name);
    if (!existsSync(f)) fail(`Chưa có khoá cho "${name}" trên máy này — nhờ quản trị workspace cấp khoá rồi lưu vào ${f} (xem README)`, 2);
    cfg = JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));
    if (!cfg.key || !cfg.mcp_url) fail(`Tệp khoá hỏng: ${f}`, 2);
    return cfg;
  };
  let board = boardOf(flags, null); // --board / DBIO_BOARD ngay; trường board của khoá + server ⇒ init()
  /** Lỗi server ⇒ NÉM; khoá sai ⇒ thoát 2 ngay. */
  async function call(tool, args) {
    const c = load();
    const res = await fetch(c.mcp_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: { ...(c.store_id ? { store_id: c.store_id } : {}), ...args } } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403) fail(`Khoá bị từ chối (HTTP ${res.status}) — nhờ quản trị cấp lại khoá`, 2);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    const line = raw.trimStart().startsWith('{') ? raw : (raw.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
    let rpc; try { rpc = JSON.parse(line); } catch { throw new Error(`Phản hồi không đọc được: ${raw.slice(0, 200)}`); }
    if (rpc.error) throw new Error(`rpc: ${rpc.error.message ?? JSON.stringify(rpc.error)}`);
    const text = rpc.result?.content?.[0]?.text ?? '{}';
    let r; try { r = JSON.parse(text); } catch { r = { success: true, text }; }
    if (r.success === false) { const e = new Error(`từ chối: ${r.error ?? r.message ?? 'lỗi'}${r.code ? ` [${r.code}]` : ''}`); e.code = r.code; e.details = r.details; throw e; } // #688: code/details để CLI phân biệt lane_busy, sha_mismatch…
    return r;
  }
  /** Chốt sổ cái trước khi dùng tb/ref: --board · DBIO_BOARD · khoá.board · server (thẻ đang cầm của chính mình). Không chốt được ⇒ báo cách đặt (không đoán). */
  async function init() {
    if (board) return board;
    board = boardOf(flags, load());
    if (board) return board;
    try {
      const me = ((await call('ai_character', { action: 'staff_list', kind: 'internal' })).staff ?? []).find((s) => String(s.name).trim().toLowerCase() === String(name).trim().toLowerCase());
      board = Number(me?.task?.board_id) || null;
    } catch { board = null; }
    if (!board) fail(`Chưa biết sổ cái của "${name}": đặt --board <id> hoặc biến DBIO_BOARD, hoặc thêm "board": <id> vào tệp khoá (${keyFile(name)}); hoặc nhận một thẻ để máy chủ tự gắn.`, 2);
    return board;
  }
  return {
    who: name, get board() { return board; }, call, init,
    tb: (action, args = {}) => call('task_board', { action, profile_id: board, as: name, ...args }),
    ai: (action, args = {}) => call('ai_character', { action, ...args }),
    ref: (id) => `${board}#${id}`,
  };
}

/** Chạy thân lệnh, in lỗi gọn thay vì stack trace. */
export async function run(fn) { try { await fn(); } catch (e) { die(`lỗi: ${e?.message ?? e}`); } }
