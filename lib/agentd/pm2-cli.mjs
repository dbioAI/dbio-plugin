/**
 * lib/agentd/pm2-cli.mjs — thực thi pm2Plan (service.mjs) cho `dbio-agentd install|uninstall|status --pm2` (#1036).
 * Windows: pm2 là pm2.cmd ⇒ cần shell cho đúng lệnh `pm2` (các lệnh khác chạy thẳng).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PM2_NAME, pm2Plan } from './service.mjs';

const win = process.platform === 'win32';
export const runStep = (c, ...a) => spawnSync(c, a, { encoding: 'utf8', shell: win && (c === 'pm2' || c === 'npm'), windowsHide: true });
const planOf = (script, withEnv) => pm2Plan({ platform: process.platform, node: process.execPath, script, home: homedir(), env: withEnv ? { PATH: process.env.PATH, DBIO_AGENTD_CONFIG: process.env.DBIO_AGENTD_CONFIG } : {} });
const brief = (r) => (r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 200);

export function installPm2({ script, flags, configFile, log = console.log, err = console.error }) {
  const plan = planOf(script, true);
  if (flags.dry) {
    for (const f of plan.files) log(`# ghi ${f.path}\n${f.content}`);
    for (const st of plan.steps) log(`# ${st.label}\n$ ${st.cmd.join(' ')}`);
    for (const n of plan.notes) log(`# ${n}`);
    return { ok: true };
  }
  if (runStep('pm2', '--version').status !== 0) {
    if (!flags.yes) return { ok: false, error: 'chưa có PM2 — chạy lại với --yes để tự `npm i -g pm2`, hoặc cài tay.' };
    const r = runStep('npm', 'i', '-g', 'pm2'); if (r.status !== 0) return { ok: false, error: `npm i -g pm2 → ${brief(r)}` };
  }
  if (!existsSync(configFile())) err(`[agentd] lưu ý: chưa có ${configFile()} — chạy \`dbio-agentd init\` rồi điền nhân viên.`);
  mkdirSync(join(homedir(), '.dbio', 'agentd-logs'), { recursive: true });
  for (const f of plan.files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.content); }
  for (const st of plan.steps) { const [c, ...a] = st.cmd; const r = runStep(c, ...a); if (r.status !== 0 && !st.optional) return { ok: false, error: `${st.label}: ${st.cmd.join(' ')} → ${brief(r)}` }; }
  log(`ok đã cài dưới PM2 (${plan.platform}). Kiểm: dbio-agentd status --pm2\n${plan.notes.join('\n')}`);
  return { ok: true };
}

export function uninstallPm2({ script, flags, log = console.log }) {
  const plan = planOf(script, false);
  if (flags.dry) { for (const st of plan.uninstall) log(`# ${st.label}\n$ ${st.cmd.join(' ')}`); for (const f of plan.remove) log(`# xoá ${f}`); return; }
  for (const st of plan.uninstall) { const [c, ...a] = st.cmd; runStep(c, ...a); }
  for (const f of plan.remove) { try { unlinkSync(f); } catch { /* chưa có */ } }
  log('ok đã gỡ khỏi PM2 (cấu hình + log còn nguyên).');
}

/** ⇒ {registered, line} — trạng thái tiến trình dbio-agentd trong PM2. */
export function statusPm2({ script }) {
  const plan = planOf(script, false); const q = runStep(plan.query[0], ...plan.query.slice(1));
  let info = null; try { info = JSON.parse(q.stdout || '[]').find((x) => x.name === PM2_NAME) ?? null; } catch { /* bỏ */ }
  return { registered: !!info, line: info ? `PM2: ${info.pm2_env?.status} · khởi động lại ${info.pm2_env?.restart_time ?? 0} lần · bộ nhớ ${Math.round((info.monit?.memory ?? 0) / 1048576)}MB` : 'PM2: chưa có tiến trình dbio-agentd' };
}
