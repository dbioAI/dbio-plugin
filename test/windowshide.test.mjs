// #1110 — agentd / dbio-plugin / dbio-internal KHÔNG được bật cửa sổ cmd lên màn hình chủ: mọi lời gọi child_process phải có windowsHide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fix, scan } from '../scripts/windowshide-scan.mjs';
import { readAccountLive } from '../lib/agentd/runs.mjs';
import { pm2Plan } from '../lib/agentd/service.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const INTERNAL = join(PLUGIN, '..', 'dbio-internal');
const walk = (d) => readdirSync(d).flatMap((n) => { if (['node_modules', 'test', 'dist'].includes(n) || n.startsWith('.')) return []; const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(mjs|js|cjs)$/.test(n) ? [p] : []; });

test('quét mã: mọi spawn/exec/execFile(Sync) trong dbio-plugin + dbio-internal đều có windowsHide', () => {
  const bad = [];
  for (const root of [PLUGIN, INTERNAL]) {
    if (!existsSync(root)) continue; // dbio-internal có thể vắng trong gói phát hành
    for (const f of walk(root)) for (const b of scan(readFileSync(f, 'utf8'))) bad.push(`${relative(join(PLUGIN, '..'), f)}:${b.line} ${b.fn}`);
  }
  assert.deepEqual(bad, [], 'thiếu windowsHide ⇒ Windows nháy cửa sổ cmd:\n' + bad.join('\n'));
});

test('bộ quét: bắt lời gọi thiếu windowsHide, bỏ qua RegExp.exec và lời gọi đã có', () => {
  const head = "import { spawnSync, execFileSync } from 'node:child_process';\n";
  assert.equal(scan(head + "spawnSync('a', ['b'], { encoding: 'utf8' });").length, 1);
  assert.equal(scan(head + "execFileSync('git', ['log']);").length, 1);
  assert.equal(scan(head + "spawnSync('a', [], {\n  cwd: x,\n  windowsHide: true });").length, 0);
  assert.equal(scan(head + "const m = /x/.exec(s); re.exec(s);").length, 0);
  assert.equal(scan("exec('a')").length, 0); // không import child_process
  const f = fix(head + "execFileSync('git', ['log']); spawnSync('a', [], { cwd: 1 });");
  assert.equal(scan(f.src).length, 0);
});

test('readAccountLive: đọc email từ .claude.json TRƯỚC, không gọi claude auth status khi tệp có', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-')); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }));
  let calls = 0;
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir }; delete env.DBIO_AGENTD_NO_LIVE_AUTH;
  assert.equal(readAccountLive(env, () => { calls++; return '{}'; })?.email, 'a@b.c');
  assert.equal(calls, 0);
  const empty = mkdtempSync(join(tmpdir(), 'wh-')); // không tệp ⇒ rơi về claude auth status
  const r = readAccountLive({ ...env, CLAUDE_CONFIG_DIR: empty, HOME: empty, USERPROFILE: empty }, () => { calls++; return JSON.stringify({ email: 'live@x.y' }); });
  if (r?.email === 'live@x.y') assert.equal(calls, 1); // (máy có ~/.claude.json thật thì tệp thắng — vẫn không gọi)
});

test('pm2Plan Windows: tác vụ resurrect chạy ẨN (conhost --headless), không dùng cmd.exe trần', () => {
  const p = pm2Plan({ platform: 'win32', script: 'x.mjs', home: tmpdir() });
  const step = p.steps.find((s) => /pm2 resurrect/.test(s.label)); const c = step.cmd.join(' ');
  assert.match(c, /-Execute 'conhost\.exe' -Argument '--headless cmd\.exe \/c pm2 resurrect'/);
  assert.doesNotMatch(c, /-Execute 'cmd\.exe'/);
});
