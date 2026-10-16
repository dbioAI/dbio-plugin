import './helpers/hermetic.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pm2Plan, PM2_NAME } from '../lib/agentd/service.mjs';

const base = { node: '/usr/bin/node', script: '/p/bin/dbio-agentd.mjs', home: '/home/u' };

test('pm2Plan: tệp ecosystem có autorestart + giới hạn bộ nhớ, KHÔNG chép bí mật, bỏ PATH', () => {
  const p = pm2Plan({ platform: 'linux', ...base, env: { DBIO_AGENTD_CONFIG: '/c.json', PATH: '/x', ANTHROPIC_API_KEY: 'sk-1', MY_TOKEN: 't' } });
  const c = p.files[0].content;
  assert.match(c, /autorestart: true/); assert.match(c, /max_memory_restart/); assert.match(c, /DBIO_AGENTD_CONFIG/);
  assert.doesNotMatch(c, /sk-1|MY_TOKEN|"PATH"/);
  assert.ok(p.steps.some((s) => s.cmd.join(' ').includes('pm2 start')) && p.steps.some((s) => s.cmd.join(' ').includes('pm2 save')));
  assert.match(p.notes.join('\n'), /pm2 startup/);
});

test('pm2Plan Windows: gỡ tác vụ cũ TRƯỚC khi pm2 start; resurrect lúc đăng nhập; loại tiến trình của chính nó khỏi diệt', () => {
  const p = pm2Plan({ platform: 'win32', ...base, home: 'C:/h' });
  const idx = (re) => p.steps.findIndex((s) => re.test(s.cmd.join(' ')));
  assert.ok(idx(/Unregister-ScheduledTask -TaskName 'dbio-agentd'/) >= 0 && idx(/Unregister-ScheduledTask -TaskName 'dbio-agentd'/) < idx(/pm2 start/));
  assert.match(p.steps[idx(/dbio-agentd-watchdog/)].cmd.join(' '), /-ne \$PID/);
  assert.match(p.steps[idx(/pm2 resurrect/)].cmd.join(' '), new RegExp(`${PM2_NAME}-resurrect`));
  assert.ok(idx(/pm2 resurrect/) > idx(/pm2 save/));
  assert.ok(p.uninstall.some((s) => /Unregister-ScheduledTask.*resurrect/.test(s.cmd.join(' '))));
});

test('pm2Plan Mac/Linux: gỡ dịch vụ kiểu cũ trước', () => {
  assert.match(pm2Plan({ platform: 'darwin', ...base }).steps[0].cmd.join(' '), /launchctl unload/);
  assert.match(pm2Plan({ platform: 'linux', ...base }).steps[0].cmd.join(' '), /systemctl --user disable/);
});

test('#1060 (1) pm2Plan Windows: gỡ cả tác vụ KHÁC TÊN chạy launcher cũ + xoá tệp launcher, trước pm2 start; không đụng tác vụ resurrect', () => {
  const p = pm2Plan({ platform: 'win32', ...base, home: 'C:/h' });
  const i = p.steps.findIndex((s) => /dbio-agentd-run/.test(s.cmd.join(' ')) && /Get-ScheduledTask/.test(s.cmd.join(' ')));
  assert.ok(i >= 0 && i < p.steps.findIndex((s) => /pm2 start/.test(s.cmd.join(' '))));
  const c = p.steps[i].cmd.join(' ');
  assert.match(c, /Remove-Item -LiteralPath '[^']*dbio-agentd-run\.ps1' -Force/); assert.match(c, /-ne 'dbio-agentd-resurrect'/);
  assert.equal(p.steps[i].optional, true);
});
