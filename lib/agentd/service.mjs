/**
 * lib/agentd/service.mjs — cài daemon thành DỊCH VỤ của người dùng (không cần quyền admin): launchd (macOS) · Task Scheduler (Windows) · systemd --user (Linux).
 * installPlan() là hàm THUẦN (trả tệp cần ghi + lệnh cần chạy) ⇒ test được và `install --dry` in ra không đụng máy. Thực thi ở bin/dbio-agentd.mjs.
 * Tự sống lại: launchd KeepAlive · systemd Restart=always · Windows: tập lệnh khởi chạy vòng lặp (chạy lại sau 10 giây khi daemon thoát).
 */
import { join } from 'node:path';

export const SERVICE_NAME = 'dbio-agentd';
export const LAUNCHD_LABEL = 'vn.dbio.agentd';

export const SECRET_ENV = /TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL|^ANTHROPIC_|^CLAUDE_CODE_OAUTH/i;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** platform: 'darwin' | 'win32' | 'linux'. ⇒ {platform, files: [{path, content, mode?}], install: [[cmd, ...args]], uninstall: [[...]], query: [cmd, ...args], notes: []} */
export function installPlan({ platform, node, script, home, logDir, env = {} }) {
  const logs = logDir ?? join(home, '.dbio', 'agentd-logs');
  // #965: KHÔNG bao giờ chép bí mật vào plist/tệp khởi chạy/unit (token hết hạn ⇒ chết cả máy, lại lộ trong tệp). Phiên con dùng đăng nhập sẵn của người dùng.
  const envPairs = Object.entries(env).filter(([k, v]) => v != null && v !== '' && !SECRET_ENV.test(k));
  if (platform === 'darwin') {
    const plist = join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const envXml = envPairs.length ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envPairs.map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}\n  </dict>\n` : '';
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${LAUNCHD_LABEL}</string>\n  <key>ProgramArguments</key>\n  <array><string>${xml(node)}</string><string>${xml(script)}</string><string>run</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>10</integer>\n  <key>StandardOutPath</key><string>${xml(join(logs, 'agentd.out.log'))}</string>\n  <key>StandardErrorPath</key><string>${xml(join(logs, 'agentd.err.log'))}</string>\n${envXml}</dict>\n</plist>\n`;
    return { platform, files: [{ path: plist, content }], install: [['launchctl', 'unload', plist], ['launchctl', 'load', '-w', plist]], uninstall: [['launchctl', 'unload', '-w', plist]], remove: [plist], query: ['launchctl', 'list', LAUNCHD_LABEL], notes: [] };
  }
  if (platform === 'win32') {
    const launcher = join(home, '.dbio', 'dbio-agentd-run.ps1');
    const wenv = envPairs.filter(([k]) => k !== 'PATH'); // Windows: tác vụ đăng nhập thừa hưởng PATH người dùng
    const content = `# dbio-agentd — khởi chạy + tự chạy lại sau 10 giây khi daemon thoát (sinh bởi \`dbio-agentd install\`, đừng sửa tay)\n${wenv.map(([k, v]) => `$env:${k} = ${ps(v)}`).join('\n')}${wenv.length ? '\n' : ''}New-Item -ItemType Directory -Force -Path ${ps(logs)} | Out-Null\nwhile ($true) {\n  & ${ps(node)} ${ps(script)} run 2>&1 | Out-File -Append -Encoding utf8 -FilePath ${ps(join(logs, 'agentd.log'))}\n  Start-Sleep -Seconds 10\n}\n`;
    const psExe = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
    const arg = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcher}"`;
    const register = `$u = "$env:USERDOMAIN\\$env:USERNAME"; $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${ps(arg)}; $t = New-ScheduledTaskTrigger -AtLogOn -User $u; $p = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited; $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero); Register-ScheduledTask -TaskName '${SERVICE_NAME}' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`;
    return {
      platform, files: [{ path: launcher, content: `﻿${content}` }],
      install: [[...psExe, register], [...psExe, `Start-ScheduledTask -TaskName '${SERVICE_NAME}'`]],
      uninstall: [[...psExe, `Stop-ScheduledTask -TaskName '${SERVICE_NAME}' -ErrorAction SilentlyContinue`], [...psExe, `Unregister-ScheduledTask -TaskName '${SERVICE_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`]], remove: [launcher],
      query: [...psExe, `Get-ScheduledTask -TaskName '${SERVICE_NAME}' -ErrorAction Stop | Out-Null`],
      notes: ['Chạy khi đăng nhập Windows (Register-ScheduledTask, không cần quyền admin; schtasks /SC ONLOGON bị từ chối khi không admin). Máy phải đăng nhập tài khoản này để daemon chạy.'],
    };
  }
  const unit = join(home, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  const content = `[Unit]\nDescription=dbio-agentd — daemon nhận việc cho nhân viên AI\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=${sh(node)} ${sh(script)} run\nRestart=always\nRestartSec=10\n${envPairs.map(([k, v]) => `Environment=${sh(`${k}=${v}`)}`).join('\n')}${envPairs.length ? '\n' : ''}\n[Install]\nWantedBy=default.target\n`;
  return { platform: 'linux', files: [{ path: unit, content }], install: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', SERVICE_NAME]], uninstall: [['systemctl', '--user', 'disable', '--now', SERVICE_NAME]], remove: [unit], query: ['systemctl', '--user', 'is-active', SERVICE_NAME], notes: ['Muốn chạy khi chưa đăng nhập: `loginctl enable-linger $USER`.'] };
}
