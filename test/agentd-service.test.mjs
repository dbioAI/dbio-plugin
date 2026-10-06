import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAUNCHD_LABEL, SERVICE_NAME, installPlan } from '../lib/agentd/service.mjs';

const base = { node: '/usr/local/bin/node', script: '/opt/dbio-plugin/bin/dbio-agentd.mjs', home: '/home/u' };

test('macOS: plist launchd KeepAlive + RunAtLoad, lệnh run, thoát ký tự XML trong env', () => {
  const p = installPlan({ ...base, platform: 'darwin', env: { PATH: '/a:/b&c', X: undefined } });
  assert.equal(p.files.length, 1);
  assert.match(p.files[0].path, /LaunchAgents[\\/]vn\.dbio\.agentd\.plist$/);
  const c = p.files[0].content;
  assert.match(c, /<key>KeepAlive<\/key><true\/>/); assert.match(c, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(c, /<string>run<\/string>/); assert.ok(c.includes(`<string>${LAUNCHD_LABEL}</string>`));
  assert.ok(c.includes('/a:/b&amp;c') && !c.includes('<key>X</key>'));
  assert.deepEqual(p.install.at(-1).slice(0, 2), ['launchctl', 'load']);
});

test('Windows: Task Scheduler ONLOGON không cần admin (/RL LIMITED), trình khởi chạy tự chạy lại, không nhúng PATH', () => {
  const p = installPlan({ ...base, platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe', script: 'D:\\p\\bin\\dbio-agentd.mjs', home: 'C:\\Users\\a', env: { PATH: 'C:\\x', DBIO_AGENTD_CONFIG: "C:\\o'hara\\c.json" } });
  const create = p.install[0];
  assert.deepEqual([create[0], create[1], create[3], create[5]], ['schtasks', '/Create', SERVICE_NAME, 'ONLOGON']);
  assert.ok(create.includes('LIMITED') && create.includes('/F'));
  assert.match(create[create.indexOf('/TR') + 1], /powershell\.exe .*-WindowStyle Hidden .*dbio-agentd-run\.ps1/);
  const ps = p.files[0].content;
  assert.match(ps, /while \(\$true\)/); assert.match(ps, /Start-Sleep -Seconds 10/);
  assert.ok(!ps.includes('$env:PATH'));
  assert.ok(ps.includes("$env:DBIO_AGENTD_CONFIG = 'C:\\o''hara\\c.json'"), 'nháy đơn được nhân đôi (PowerShell)');
  assert.ok(ps.includes("& 'C:\\Program Files\\nodejs\\node.exe' 'D:\\p\\bin\\dbio-agentd.mjs' run"));
  assert.ok(ps.startsWith('\uFEFF'), 'BOM để PowerShell 5.1 đọc đúng tiếng Việt');
  assert.deepEqual(p.uninstall.map((c) => c[1]), ['/End', '/Delete']);
});

test('Linux: systemd --user Restart=always, enable --now, thoát nháy đơn', () => {
  const p = installPlan({ ...base, platform: 'linux', env: { DBIO_AGENTD_CONFIG: "/h/o'k.json" } });
  const c = p.files[0].content;
  assert.match(p.files[0].path, /\.config[\\/]systemd[\\/]user[\\/]dbio-agentd\.service$/);
  assert.match(c, /Restart=always/); assert.match(c, /WantedBy=default\.target/);
  assert.match(c, /ExecStart='\/usr\/local\/bin\/node' '\/opt\/dbio-plugin\/bin\/dbio-agentd\.mjs' run/);
  assert.ok(c.includes(`Environment='DBIO_AGENTD_CONFIG=/h/o'\\''k.json'`));
  assert.deepEqual(p.install[1], ['systemctl', '--user', 'enable', '--now', SERVICE_NAME]);
  assert.ok(p.notes.some((n) => /linger/.test(n)));
});

test('mọi nền tảng có lệnh query + danh sách tệp cần xoá khi gỡ', () => {
  for (const platform of ['darwin', 'win32', 'linux']) { const p = installPlan({ ...base, platform }); assert.ok(p.query.length >= 2, platform); assert.ok(p.remove.length >= 1, platform); assert.ok(p.uninstall.length >= 1, platform); }
});
