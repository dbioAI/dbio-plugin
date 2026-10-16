/**
 * lib/agentd/service.mjs — cài daemon thành DỊCH VỤ của người dùng (không cần quyền admin): launchd (macOS) · Task Scheduler (Windows) · systemd --user (Linux).
 * installPlan() là hàm THUẦN (trả tệp cần ghi + lệnh cần chạy) ⇒ test được và `install --dry` in ra không đụng máy. Thực thi ở bin/dbio-agentd.mjs.
 * Tự sống lại: launchd KeepAlive · systemd Restart=always · Windows: tập lệnh khởi chạy vòng lặp (chạy lại sau 10 giây khi daemon thoát) + trigger lặp 5 phút dựng lại chính trình khởi chạy nếu nó chết lặng.
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
    const content = `# dbio-agentd — khởi chạy + tự chạy lại sau 10 giây khi daemon thoát (sinh bởi \`dbio-agentd install\`, đừng sửa tay)\n${wenv.map(([k, v]) => `$env:${k} = ${ps(v)}`).join('\n')}${wenv.length ? '\n' : ''}New-Item -ItemType Directory -Force -Path ${ps(logs)} | Out-Null\nwhile ($true) {\n  Add-Content -Encoding utf8 -Path ${ps(join(logs, 'agentd.log'))} -Value ('[wrapper ' + (Get-Date).ToUniversalTime().ToString('HH:mm:ss') + 'Z] khởi chạy daemon')\n  & ${ps(node)} ${ps(script)} run 2>&1 | Out-File -Append -Encoding utf8 -FilePath ${ps(join(logs, 'agentd.log'))}\n  Add-Content -Encoding utf8 -Path ${ps(join(logs, 'agentd.log'))} -Value ('[wrapper ' + (Get-Date).ToUniversalTime().ToString('HH:mm:ss') + 'Z] daemon thoát, mã ' + $LASTEXITCODE + ' — chạy lại sau 10s')\n  Start-Sleep -Seconds 10\n}\n`;
    const psExe = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
    const arg = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcher}"`;
    const register = `$u = "$env:USERDOMAIN\\$env:USERNAME"; $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${ps(arg)}; $t = New-ScheduledTaskTrigger -AtLogOn -User $u; $w = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650); $p = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited; $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero); Register-ScheduledTask -TaskName '${SERVICE_NAME}' -Action $a -Trigger @($t, $w) -Principal $p -Settings $s -Force | Out-Null`;
    return {
      platform, files: [{ path: launcher, content: `﻿${content}` }],
      install: [[...psExe, register], [...psExe, `Start-ScheduledTask -TaskName '${SERVICE_NAME}'`]],
      uninstall: [[...psExe, `Stop-ScheduledTask -TaskName '${SERVICE_NAME}' -ErrorAction SilentlyContinue`], [...psExe, `Unregister-ScheduledTask -TaskName '${SERVICE_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`]], remove: [launcher],
      query: [...psExe, `Get-ScheduledTask -TaskName '${SERVICE_NAME}' -ErrorAction Stop | Out-Null`],
      notes: ['Chạy khi đăng nhập Windows (Register-ScheduledTask, không cần quyền admin; schtasks /SC ONLOGON bị từ chối khi không admin). Máy phải đăng nhập tài khoản này để daemon chạy.', 'Canh chết lặng (#1036): thêm trigger lặp 5 phút + MultipleInstances=IgnoreNew — trình khởi chạy còn sống thì không làm gì, bị diệt/chết âm thầm (tác vụ "Ready" mà không có tiến trình) thì tối đa 5 phút sau tự dựng lại.'],
    };
  }
  const unit = join(home, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  const content = `[Unit]\nDescription=dbio-agentd — daemon nhận việc cho nhân viên AI\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=${sh(node)} ${sh(script)} run\nRestart=always\nRestartSec=10\n${envPairs.map(([k, v]) => `Environment=${sh(`${k}=${v}`)}`).join('\n')}${envPairs.length ? '\n' : ''}\n[Install]\nWantedBy=default.target\n`;
  return { platform: 'linux', files: [{ path: unit, content }], install: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', SERVICE_NAME]], uninstall: [['systemctl', '--user', 'disable', '--now', SERVICE_NAME]], remove: [unit], query: ['systemctl', '--user', 'is-active', SERVICE_NAME], notes: ['Muốn chạy khi chưa đăng nhập: `loginctl enable-linger $USER`.'] };
}

export const PM2_NAME = 'dbio-agentd';
const LEGACY_TASKS = ['dbio-agentd', 'dbio-agentd-watchdog'];

/**
 * #1036 (chủ chốt 14/10): giám sát tiến trình = PM2 (autorestart, max_memory_restart, log), không tự viết, không Task Scheduler giữ tiến trình dài.
 * Hàm THUẦN như installPlan. ⇒ {platform, files, steps: [{label, cmd: [..], optional?}], uninstall: [steps], remove: [tệp], notes}.
 * Windows: PM2 không tự bật cùng máy ⇒ tác vụ CHẠY 1 LẦN lúc đăng nhập gọi `pm2 resurrect` (không giữ tiến trình). Linux/Mac: `pm2 startup` in ra 1 lệnh sudo — người vận hành chạy 1 lần.
 */
export function pm2Plan({ platform, node, script, home, logDir, env = {} }) {
  const logs = logDir ?? join(home, '.dbio', 'agentd-logs');
  const eco = join(home, '.dbio', 'agentd.ecosystem.config.cjs');
  const envPairs = Object.entries(env).filter(([k, v]) => v != null && v !== '' && !SECRET_ENV.test(k) && k !== 'PATH'); // #965: không chép bí mật
  const ecoContent = `// dbio-agentd — cấu hình PM2 (sinh bởi \`dbio-agentd install --pm2\`, đừng sửa tay)\nmodule.exports = { apps: [{\n  name: ${JSON.stringify(PM2_NAME)},\n  script: ${JSON.stringify(script)},\n  args: 'run',\n  interpreter: ${JSON.stringify(node)},\n  autorestart: true,\n  min_uptime: '10s',\n  restart_delay: 5000,\n  max_restarts: 1000,\n  max_memory_restart: '700M',\n  kill_timeout: 15000,\n  windowsHide: true,\n  merge_logs: true,\n  time: true,\n  out_file: ${JSON.stringify(join(logs, 'agentd.out.log'))},\n  error_file: ${JSON.stringify(join(logs, 'agentd.err.log'))},\n  env: ${JSON.stringify(Object.fromEntries(envPairs))},\n}] };\n`;
  const files = [{ path: eco, content: ecoContent }];
  const steps = [{ label: 'dừng daemon kiểu cũ (nếu có)', cmd: ['pm2', 'delete', PM2_NAME], optional: true }];
  const uninstall = [{ label: 'gỡ khỏi PM2', cmd: ['pm2', 'delete', PM2_NAME], optional: true }, { label: 'lưu danh sách PM2', cmd: ['pm2', 'save', '--force'], optional: true }];
  const remove = [eco];
  const notes = ['Cần PM2: `npm i -g pm2` (install --pm2 tự cài nếu thiếu và có --yes).'];
  if (platform === 'win32') {
    const psExe = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
    const legacyStop = LEGACY_TASKS.map((t) => `Stop-ScheduledTask -TaskName '${t}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${t}' -Confirm:$false -ErrorAction SilentlyContinue`).join('; ');
    // #1060 (1): tác vụ lịch KHÁC TÊN nhưng chạy launcher cũ (hoặc daemon qua node trực tiếp) cũng gỡ; xoá tệp launcher để không ai bật lại
    const legacyByAction = "Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { ($_.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -match 'dbio-agentd-run|dbio-agentd\.mjs' -and $_.TaskName -ne '" + PM2_NAME + "-resurrect' } | ForEach-Object { Stop-ScheduledTask -InputObject $_ -ErrorAction SilentlyContinue; Unregister-ScheduledTask -InputObject $_ -Confirm:$false -ErrorAction SilentlyContinue }";
    const rmLauncher = `Remove-Item -LiteralPath '${join(home, '.dbio', 'dbio-agentd-run.ps1').replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`;
    const killWrapper = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -match 'dbio-agentd-run\.ps1' -or $_.CommandLine -match 'dbio-agentd\.mjs.* run') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    const resurrect = `$u = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c pm2 resurrect'; $t = New-ScheduledTaskTrigger -AtLogOn -User $u; $p = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited; $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5); Register-ScheduledTask -TaskName '${PM2_NAME}-resurrect' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`;
    steps.unshift({ label: 'gỡ tác vụ kiểu cũ (dbio-agentd, dbio-agentd-watchdog) + tiến trình trình khởi chạy cũ', cmd: [...psExe, `${legacyStop}; ${legacyByAction}; ${killWrapper}; ${rmLauncher}`], optional: true });
    steps.push({ label: 'chạy daemon dưới PM2', cmd: ['pm2', 'start', eco] }, { label: 'lưu danh sách PM2', cmd: ['pm2', 'save', '--force'] }, { label: 'tác vụ 1 lần lúc đăng nhập: pm2 resurrect', cmd: [...psExe, resurrect] });
    uninstall.push({ label: 'gỡ tác vụ resurrect', cmd: [...psExe, `Unregister-ScheduledTask -TaskName '${PM2_NAME}-resurrect' -Confirm:$false -ErrorAction SilentlyContinue`], optional: true });
    notes.push('Windows: tác vụ "dbio-agentd-resurrect" chỉ chạy `pm2 resurrect` lúc đăng nhập rồi thoát (không giữ tiến trình). Muốn chạy cả khi chưa đăng nhập: dịch vụ WinSW/node-windows (làm sau nếu cần).');
  } else {
    steps.push({ label: 'chạy daemon dưới PM2', cmd: ['pm2', 'start', eco] }, { label: 'lưu danh sách PM2', cmd: ['pm2', 'save', '--force'] });
    notes.push(platform === 'darwin' ? 'Mac: chạy `pm2 startup` 1 lần — nó in ra 1 lệnh (launchd) để bạn dán chạy.' : 'Linux: chạy `pm2 startup systemd` 1 lần — nó in ra 1 lệnh sudo để bạn dán chạy (+ `loginctl enable-linger $USER` nếu cần chạy khi chưa đăng nhập).');
    if (platform === 'darwin') steps.unshift({ label: 'gỡ launchd kiểu cũ', cmd: ['launchctl', 'unload', join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)], optional: true });
    else steps.unshift({ label: 'gỡ systemd kiểu cũ', cmd: ['systemctl', '--user', 'disable', '--now', SERVICE_NAME], optional: true });
  }
  return { platform, files, steps, uninstall, remove, query: ['pm2', 'jlist'], notes };
}
