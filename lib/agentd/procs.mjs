/**
 * lib/agentd/procs.mjs — soi tiến trình máy (#1060): (2) daemon mới GIẾT daemon cũ cùng đường dẫn script thay vì đứng chờ; (3) đếm `claude --name` đang sống so với sổ Run mở (open.json).
 * Phần chọn lọc là hàm THUẦN (test được); chỉ listProcs() chạm hệ điều hành. Không bao giờ ném lỗi.
 */
import { execFile } from 'node:child_process';

const win = process.platform === 'win32';
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/"/g, '').toLowerCase();

/** ⇒ Promise<[{pid, cmd}]> (lỗi ⇒ []). Windows: Get-CimInstance; còn lại: ps. */
export function listProcs({ timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const done = (err, out) => {
      if (err || !out) return resolve([]);
      try {
        if (win) { const j = JSON.parse(out); return resolve((Array.isArray(j) ? j : [j]).filter((x) => x?.CommandLine).map((x) => ({ pid: Number(x.ProcessId), cmd: String(x.CommandLine) }))); }
        resolve(String(out).split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), cmd: m[2] })));
      } catch { resolve([]); }
    };
    if (win) execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'node|claude' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20 }, done);
    else execFile('ps', ['-eo', 'pid=,args='], { timeout: timeoutMs, maxBuffer: 16 << 20 }, done);
  });
}

/** Daemon khác chạy CÙNG script (`<script> run`) — trừ chính mình. Chỉ khớp đúng đường dẫn script, không đụng tiến trình lạ. */
export function sameScriptDaemons(procs, script, self = process.pid) {
  const s = norm(script);
  return (procs ?? []).filter((p) => p.pid !== self && norm(p.cmd).includes(s) && /\brun\b/.test(p.cmd));
}

/** Lượt ngầm = `claude … -p … --name <tên>` (agentd spawn). Phiên tương tác/ghim (không -p) không tính. */
export function claudeNamed(procs) {
  return (procs ?? []).filter((p) => /(^|[\\/"\s])claude(\.exe|\.cmd)?("|\s)/i.test(p.cmd) && /\s--name\s/.test(p.cmd) && /\s-p(\s|$)/.test(p.cmd));
}

/** Đối chiếu số tiến trình thật với số Run mở còn sống. ⇒ {named, open, mismatch, extra:[pid], pids} (extra = pid claude --name không thuộc Run mở nào). */
export function reconcileProcs(procs, openRuns, alive) {
  const named = claudeNamed(procs); const live = (openRuns ?? []).filter((r) => r.pid && alive(r.pid));
  const known = new Set(live.map((r) => r.pid));
  // pid của Run có thể là wrapper (cmd/node) bọc claude ⇒ cũng coi là "đã biết" nếu cha là pid Run: không có ppid ở đây nên chỉ so theo số lượng + pid trực tiếp
  const extra = named.filter((p) => !known.has(p.pid)).map((p) => p.pid);
  return { named: named.length, open: live.length, mismatch: named.length !== live.length, extra, pids: named.map((p) => p.pid) };
}

/**
 * Giết daemon cũ cùng script rồi chờ chúng chết. Tiêm phụ thuộc để test. ⇒ {killed:[pid], stuck:[pid]}.
 * POSIX: SIGTERM (drain) rồi SIGKILL sau graceMs; Windows: process.kill = chấm dứt ngay (lượt claude con KHÔNG bị giết — daemon mới nhận nuôi qua open.json).
 */
export async function evictSameScript({ script, self = process.pid, list = listProcs, kill = (pid, sig) => process.kill(pid, sig), alive, graceMs = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waitMs = 20_000 } = {}) {
  const victims = sameScriptDaemons(await list(), script, self); const killed = [];
  for (const v of victims) { try { kill(v.pid, 'SIGTERM'); killed.push(v.pid); } catch { /* đã chết */ } }
  let waited = 0; let escalated = false;
  while (killed.length && waited < waitMs) {
    if (!killed.some((p) => alive(p))) break;
    await sleep(500); waited += 500;
    if (!escalated && waited >= graceMs) { escalated = true; for (const p of killed) if (alive(p)) { try { kill(p, 'SIGKILL'); } catch { /* bỏ */ } } }
  }
  return { killed, stuck: killed.filter((p) => alive(p)) };
}
