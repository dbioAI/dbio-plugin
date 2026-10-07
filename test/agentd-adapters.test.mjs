import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adapterNames, getAdapter, loadAdapterModules, registerAdapter } from '../lib/agentd/adapters/index.mjs';
import { isBlank, resolveDesktopSession, sessionIdFromOutput } from '../lib/agentd/adapters/claude-desktop.mjs';
import { urlAllowed } from '../lib/agentd/adapters/hermes.mjs';
import { SAFE_ARG, assertSafeArgs, resolveBin, runChild } from '../lib/agentd/adapters/util.mjs';

process.env.DBIO_AGENTD_LOG_DIR = mkdtempSync(join(tmpdir(), 'agentd-log-'));

/** spawn giả: ghi lại lệnh/tham số/stdin, thoát mã 0. */
function fakeSpawn() {
  const calls = [];
  const fn = (bin, args, opts) => {
    const child = new EventEmitter(); child.pid = 4242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let stdin = ''; child.stdin = Object.assign(new EventEmitter(), { end(s) { stdin = s ?? ''; setImmediate(() => child.emit('close', 0)); } });
    child.kill = () => {}; calls.push({ bin, args, opts, get stdin() { return stdin; } });
    return child;
  };
  return { fn, calls };
}

test('sổ đăng ký có đủ 5 adapter; cắm thêm bằng registerAdapter; adapter hỏng bị từ chối', () => {
  for (const n of ['claude-cli', 'claude-desktop', 'codex', 'hermes', 'command']) assert.ok(getAdapter(n), n);
  registerAdapter({ name: 'mine', wake: async () => ({ ok: true }) });
  assert.ok(adapterNames().includes('mine'));
  assert.throws(() => registerAdapter({ name: 'x' }));
  assert.throws(() => registerAdapter(null));
});

test('loadAdapterModules: nạp tệp .mjs export default; lỗi ⇒ báo, không ném', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ad-'));
  writeFileSync(join(d, 'a.mjs'), "export default { name: 'tu-chon', wake: async () => ({ ok: true, detail: 'hi' }) };");
  writeFileSync(join(d, 'bad.mjs'), 'export default 5;');
  const errs = await loadAdapterModules(['a.mjs', 'bad.mjs', 'khong-co.mjs'], d);
  assert.equal(errs.length, 2);
  assert.equal((await getAdapter('tu-chon').wake({})).detail, 'hi');
});

test('claude-cli: --resume <session> -p, lời nhắc qua STDIN (không nằm trên dòng lệnh)', async () => {
  const s = fakeSpawn();
  const r = await getAdapter('claude-cli').wake({ staff: 'NV1', entry: { session: 'abc-123', cwd: '/w', args: ['--permission-mode', 'acceptEdits'] }, prompt: 'làm việc đi; rm -rf / $(x)', spawnFn: s.fn });
  assert.ok(r.ok);
  assert.deepEqual(s.calls[0].args, ['--resume', 'abc-123', '-p', '--permission-mode', 'acceptEdits']);
  assert.equal(s.calls[0].stdin, 'làm việc đi; rm -rf / $(x)');
  assert.equal(s.calls[0].opts.cwd, '/w');
  assert.equal((await r.running).code, 0);
  assert.ok(!(await getAdapter('claude-cli').wake({ staff: 'NV1', entry: {}, prompt: 'x' })).ok, 'thiếu session ⇒ lỗi rõ');
});

test('tham số không an toàn (ký tự shell) bị từ chối TRƯỚC khi chạy', async () => {
  const s = fakeSpawn();
  for (const bad of ['a b', 'x;y', '$(id)', '`id`', 'a|b', 'a&b', 'a>b', '"q"']) {
    assert.ok(!SAFE_ARG.test(bad), bad);
    const r = await getAdapter('claude-cli').wake({ staff: 'N', entry: { session: bad }, prompt: 'x', spawnFn: s.fn });
    assert.equal(r.ok, false, bad);
  }
  assert.equal(s.calls.length, 0);
  assert.throws(() => assertSafeArgs(['ok', 'x y']));
  assert.ok(SAFE_ARG.test('local_2029cbd7-68ac-4aca-aa3e-9deab4f591df'));
  assert.ok(SAFE_ARG.test('C:\\Users\\a\\x.exe'));
});

test('session có dạng cờ lệnh (từ dữ liệu máy chủ) bị từ chối', async () => {
  const s = fakeSpawn();
  for (const bad of ['--permission-mode=bypassPermissions', '-x', '--settings=/x']) for (const a of ['claude-cli', 'codex', 'claude-desktop']) assert.equal((await getAdapter(a).wake({ staff: 'N', entry: { session: bad }, prompt: 'p', spawnFn: s.fn })).ok, false, `${a} ${bad}`);
  assert.equal(s.calls.length, 0);
});

test('command thoát sớm mã ≠ 0 ⇒ running báo mã (daemon coi là thất bại, không ack)', async () => {
  const r = await getAdapter('command').wake({ staff: 'x', entry: { command: ['khong-co-lenh-xyz-861'] }, prompt: 'p' });
  assert.ok(!r.ok || (await r.running).code !== 0);
});

test('codex: exec resume <session> - ; thiếu session ⇒ --last', async () => {
  const s = fakeSpawn();
  await getAdapter('codex').wake({ staff: 'N', entry: { session: 's1' }, prompt: 'p', spawnFn: s.fn });
  await getAdapter('codex').wake({ staff: 'N', entry: {}, prompt: 'p', spawnFn: s.fn });
  assert.deepEqual(s.calls[0].args, ['exec', 'resume', 's1', '-']);
  assert.deepEqual(s.calls[1].args, ['exec', 'resume', '--last', '-']);
});

test('claude-desktop: local_<uuid> ⇒ cliSessionId + cwd lấy từ tệp phiên của ứng dụng', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sess-'));
  const dir = join(root, 'acc', 'org'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'local_aaa.json'), JSON.stringify({ sessionId: 'local_aaa', cliSessionId: 'cli-111', cwd: 'D:\\x', title: 't' }));
  writeFileSync(join(dir, 'local_hong.json'), '{không phải json');
  assert.deepEqual(resolveDesktopSession('local_aaa', [root]), { cliSessionId: 'cli-111', blank: false, cwd: 'D:\\x', title: 't' });
  assert.equal(resolveDesktopSession('local_hong', [root]), null);
  assert.equal(resolveDesktopSession('local_khong', [root]), null);
  const s = fakeSpawn();
  const r = await getAdapter('claude-desktop').wake({ staff: 'N', entry: { session: 'local_aaa', sessions_dir: root }, prompt: 'p', spawnFn: s.fn });
  assert.ok(r.ok); assert.deepEqual(s.calls[0].args, ['--resume', 'cli-111', '-p']); assert.equal(s.calls[0].opts.cwd, 'D:\\x');
  const miss = await getAdapter('claude-desktop').wake({ staff: 'N', entry: { session: 'local_khong', sessions_dir: root }, prompt: 'p', spawnFn: s.fn });
  assert.equal(miss.ok, false); assert.match(miss.detail, /không thấy phiên/);
  await getAdapter('claude-desktop').wake({ staff: 'N', entry: { session: 'cli-direct' }, prompt: 'p', spawnFn: s.fn }); // đã là cliSessionId
  assert.deepEqual(s.calls[1].args, ['--resume', 'cli-direct', '-p']);
});

test('hermes: chỉ https (hoặc http localhost); ký HMAC bằng biến môi trường; thiếu biến ⇒ lỗi; HTTP lỗi ⇒ ok:false', async () => {
  assert.ok(urlAllowed('https://h.example/x') && urlAllowed('http://localhost:9/x') && urlAllowed('http://127.0.0.1/x'));
  assert.ok(!urlAllowed('http://evil.example/x') && !urlAllowed('ftp://x') && !urlAllowed('rác') && !urlAllowed(undefined));
  const h = getAdapter('hermes');
  let seen; const fetchFn = async (url, init) => { seen = { url, init }; return { ok: true, status: 200 }; };
  const r = await h.wake({ staff: 'H', entry: { url: 'https://h.example/hook', secret_env: 'T_SECRET' }, prompt: 'p', events: [{ id: 1, kind: 'assign', task: '1#2', text: 'x'.repeat(900) }], env: { T_SECRET: 's3' }, fetchFn });
  assert.ok(r.ok);
  const sig = seen.init.headers['x-dbio-signature'];
  assert.equal(sig, `sha256=${createHmac('sha256', 's3').update(seen.init.body).digest('hex')}`);
  const body = JSON.parse(seen.init.body); assert.equal(body.staff, 'H'); assert.equal(body.events[0].text.length, 500);
  assert.ok(!seen.init.body.includes('s3') && !JSON.stringify(seen).includes('"s3"'), 'khoá ký không rò vào thân');
  assert.equal((await h.wake({ staff: 'H', entry: { url: 'https://h.example/hook', secret_env: 'KHONG_CO' }, prompt: 'p', env: {}, fetchFn })).ok, false);
  assert.equal((await h.wake({ staff: 'H', entry: { url: 'http://evil.example' }, prompt: 'p', fetchFn })).ok, false);
  assert.equal((await h.wake({ staff: 'H', entry: { url: 'https://h.example' }, prompt: 'p', fetchFn: async () => ({ ok: false, status: 502 }) })).ok, false);
  assert.equal((await h.wake({ staff: 'H', entry: { url: 'https://h.example' }, prompt: 'p', fetchFn: async () => { throw new Error('rớt mạng'); } })).ok, false);
});

test('command: chạy lệnh THẬT, lời nhắc ở stdin + biến DBIO_WAKE_*; thoát khác 0 ⇒ running báo mã', async () => {
  const d = mkdtempSync(join(tmpdir(), 'cmd-'));
  const script = join(d, 'w.mjs'); const out = join(d, 'out.json');
  writeFileSync(script, `import fs from 'node:fs'; let s=''; process.stdin.on('data',c=>s+=c).on('end',()=>{ fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({stdin:s, staff:process.env.DBIO_WAKE_STAFF, ev:process.env.DBIO_WAKE_EVENTS})); process.exit(process.env.DBIO_WAKE_STAFF==='FAIL'?3:0); });`);
  const r = await getAdapter('command').wake({ staff: 'NV1', entry: { command: [process.execPath, script] }, prompt: 'xin chào "$HOME" `x`', events: [{ id: 9, kind: 'assign', task: '1#2', text: 'bí mật' }] });
  assert.ok(r.ok);
  assert.equal((await r.running).code, 0);
  const o = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(o.stdin, 'xin chào "$HOME" `x`'); assert.equal(o.staff, 'NV1'); assert.deepEqual(JSON.parse(o.ev), [{ id: 9, kind: 'assign', task: '1#2' }]); // chỉ id/kind/task qua env
  const f = await getAdapter('command').wake({ staff: 'FAIL', entry: { command: [process.execPath, script] }, prompt: 'p' });
  assert.equal((await f.running).code, 3);
  assert.equal((await getAdapter('command').wake({ staff: 'x', entry: {}, prompt: 'p' })).ok, false);
  assert.equal(runChild({ bin: 'khong-co-lenh-nay-xyz', args: [], input: '' }).ok === true ? (await runChild({ bin: 'khong-co-lenh-nay-xyz', args: [], input: '' }).running).code !== 0 : true, true);
});

test('runChild: quá hạn ⇒ bị kill (không treo daemon)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'hang-')); const f = join(d, 'hang.mjs'); writeFileSync(f, 'setTimeout(() => {}, 60000);');
  const r = runChild({ bin: process.execPath, args: [f], input: '', timeoutS: 0.3 });
  assert.ok(r.ok);
  const t0 = Date.now(); const x = await r.running;
  assert.ok(Date.now() - t0 < 5000); assert.notEqual(x.code, 0);
});

test('resolveBin: tên trần ⇒ đường dẫn tuyệt đối trong PATH, KHÔNG dò thư mục hiện hành; có dấu phân cách giữ nguyên', () => {
  const d = mkdtempSync(join(tmpdir(), 'bin-')); const evil = mkdtempSync(join(tmpdir(), 'evil-'));
  const ext = process.platform === 'win32' ? '.cmd' : ''; const same = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase()); writeFileSync(join(d, 'tool861' + ext), ''); writeFileSync(join(evil, 'tool861' + ext), '');
  const env = { PATH: d, PATHEXT: ext.toUpperCase() };
  same(resolveBin('tool861', env), join(d, 'tool861' + ext));
  const old = process.cwd(); process.chdir(evil);
  try { same(resolveBin('tool861', env), join(d, 'tool861' + ext)); assert.equal(resolveBin('tool861', { PATH: '.' }), 'tool861'); } finally { process.chdir(old); }
  assert.equal(resolveBin('./x', env), './x'); assert.equal(resolveBin('khong-co-861', env), 'khong-co-861');
});

test('claude-desktop activeAgoMs: mtime tệp hội thoại của phiên (đang ghi ⇒ nhỏ), không biết ⇒ null', () => {
  const root = mkdtempSync(join(tmpdir(), 'act-')); const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'local_act1.json'), JSON.stringify({ sessionId: 'local_act1', cliSessionId: 'act-cli-1' }));
  const proj = join(root, 'proj'); mkdirSync(join(proj, 'p'), { recursive: true }); writeFileSync(join(proj, 'p', 'act-cli-1.jsonl'), '{}\n');
  const ad = getAdapter('claude-desktop');
  const ms = ad.activeAgoMs({ session: 'local_act1', sessions_dir: root, projects_dir: proj });
  assert.ok(ms != null && ms > -2000 && ms < 10_000);
  assert.equal(ad.activeAgoMs({ session: 'local_khong', sessions_dir: root }), null);
  assert.equal(ad.activeAgoMs({}), null);
});

test('claude-desktop PHIÊN TRỐNG (vừa clear: tệp có, thiếu cliSessionId): KHÔNG trả null, KHÔNG --resume, chạy claude -p phiên mới trong cwd của tệp', async () => {
  const root = mkdtempSync(join(tmpdir(), 'blank-')); const dir = join(root, 'a', 'o'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'local_blank1.json'), JSON.stringify({ sessionId: 'local_blank1', cwd: 'D:\\proj', priorCliSessionIds: ['cu-111', 'cu-222'] }));
  writeFileSync(join(dir, 'local_full1.json'), JSON.stringify({ sessionId: 'local_full1', cliSessionId: 'cli-9', cwd: 'D:\\proj' }));
  const r0 = resolveDesktopSession('local_blank1', [root]);
  assert.ok(r0, 'không được null'); assert.equal(r0.blank, true); assert.equal(r0.cliSessionId, null); assert.equal(r0.cwd, 'D:\\proj');
  assert.equal(resolveDesktopSession('local_full1', [root]).blank, false);
  assert.equal(isBlank({ session: 'local_blank1', sessions_dir: root }), true); assert.equal(isBlank({ session: 'local_full1', sessions_dir: root }), false);
  assert.equal(isBlank({ session: 'uuid-x' }), false); assert.equal(isBlank({}), false);
  const s = fakeSpawn();
  const r = await getAdapter('claude-desktop').wake({ staff: 'MAC NV1', entry: { session: 'local_blank1', sessions_dir: root, blank_mode: 'headless', args: ['--permission-mode', 'acceptEdits'] }, prompt: 'PM giao thẻ #632', spawnFn: s.fn });
  assert.ok(r.ok && r.blank);
  assert.deepEqual(s.calls[0].args, ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
  assert.ok(!s.calls[0].args.includes('--resume') && !JSON.stringify(s.calls[0].args).includes('cu-111'), 'cấm --resume priorCliSessionIds');
  assert.equal(s.calls[0].opts.cwd, 'D:\\proj');
  assert.match(s.calls[0].stdin, /vừa được CLEAR/); assert.match(s.calls[0].stdin, /MAC NV1/); assert.match(s.calls[0].stdin, /next --take/); assert.match(s.calls[0].stdin, /PM giao thẻ #632/);
  assert.equal((await r.running).code, 0);
  assert.equal(sessionIdFromOutput('{"type":"result","session_id":"abc-123-def","x":1}'), 'abc-123-def'); assert.equal(sessionIdFromOutput('rác'), null);
  const rel = await getAdapter('claude-desktop').wake({ staff: 'N', entry: { session: 'local_blank1', sessions_dir: root }, prompt: 'p', spawnFn: s.fn });
  assert.equal(rel.ok, false); assert.equal(rel.relay, true, 'mặc định: phiên trống ⇒ cần cầu (PM chốt b), không chạy ngầm');
  const t = await getAdapter('claude-desktop').wake({ staff: 'N', entry: { session: 'local_blank1', sessions_dir: root, blank_mode: 'headless', blank_prompt: 'Xin chào {name} :: {prompt}' }, prompt: '$& $1', spawnFn: s.fn });
  assert.equal(s.calls[1].stdin, 'Xin chào N :: $& $1');
});
