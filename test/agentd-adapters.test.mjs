import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adapterNames, getAdapter, loadAdapterModules, registerAdapter } from '../lib/agentd/adapters/index.mjs';
import { isBlank, loadSpawn, resolveDesktopSession, roleOf, sessionIdFromOutput } from '../lib/agentd/adapters/claude-desktop.mjs';
import { urlAllowed } from '../lib/agentd/adapters/hermes.mjs';
import { SAFE_ARG, assertSafeArgs, resolveBin, runChild } from '../lib/agentd/adapters/util.mjs';

process.env.DBIO_AGENTD_LOG_DIR = mkdtempSync(join(tmpdir(), 'agentd-log-'));
process.env.DBIO_STREAM_DIR = mkdtempSync(join(tmpdir(), 'agentd-stream-')); // #1022 sổ phiên tự tạo KHÔNG ghi ra ~/.dbio
process.env.DBIO_ROLES_FILE = join(tmpdir(), 'khong-co-roles.json'); // không đọc roles.json thật của máy

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
  assert.deepEqual(s.calls[0].args, ['--resume', 'abc-123', '-p', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
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
  assert.deepEqual(resolveDesktopSession('local_aaa', [root]), { cliSessionId: 'cli-111', blank: false, cwd: 'D:\\x', title: 't', lastActivityAt: null });
  assert.equal(resolveDesktopSession('local_hong', [root]), null);
  assert.equal(resolveDesktopSession('local_khong', [root]), null);
  const s = fakeSpawn();
  const r = await getAdapter('claude-desktop').wake({ staff: 'N', entry: { session: 'local_aaa', sessions_dir: root, allow_large: true }, prompt: 'p', spawnFn: s.fn });
  assert.ok(r.ok); assert.deepEqual(s.calls[0].args, ['--resume', 'cli-111', '-p', '--output-format', 'json']); assert.equal(s.calls[0].opts.cwd, 'D:\\x');
  const miss = await getAdapter('claude-desktop').wake({ staff: 'N', entry: { session: 'local_khong', sessions_dir: root }, prompt: 'p', spawnFn: s.fn });
  assert.equal(miss.ok, false); assert.match(miss.detail, /không thấy/); // #1022 spawn: mất tệp phiên mà không biết cwd ⇒ lỗi rõ
  const missRelay = await getAdapter('claude-desktop').wake({ staff: 'N', entry: { session: 'local_khong', sessions_dir: root, blank_mode: 'relay' }, prompt: 'p', spawnFn: s.fn });
  assert.equal(missRelay.ok, false); assert.match(missRelay.detail, /không thấy phiên/);
  await getAdapter('claude-desktop').wake({ staff: 'N', entry: { session: 'cli-direct' }, prompt: 'p', spawnFn: s.fn }); // đã là cliSessionId
  assert.deepEqual(s.calls[1].args, ['--resume', 'cli-direct', '-p', '--output-format', 'json']);
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
  assert.deepEqual(s.calls[0].args, ['-p', '--output-format', 'json', '--name', 'MAC-NV1', '--permission-mode', 'acceptEdits']);
  assert.ok(!s.calls[0].args.includes('--resume') && !JSON.stringify(s.calls[0].args).includes('cu-111'), 'cấm --resume priorCliSessionIds');
  assert.equal(s.calls[0].opts.cwd, 'D:\\proj');
  assert.match(s.calls[0].stdin, /vừa được CLEAR/); assert.match(s.calls[0].stdin, /MAC NV1/); assert.match(s.calls[0].stdin, /next --take/); assert.match(s.calls[0].stdin, /PM giao thẻ #632/);
  assert.equal((await r.running).code, 0);
  assert.equal(sessionIdFromOutput('{"type":"result","session_id":"abc-123-def","x":1}'), 'abc-123-def'); assert.equal(sessionIdFromOutput('rác'), null);
  const rel = await getAdapter('claude-desktop').wake({ staff: 'N', entry: { session: 'local_blank1', sessions_dir: root, blank_mode: 'relay' }, prompt: 'p', spawnFn: s.fn });
  assert.equal(rel.ok, false); assert.equal(rel.relay, true, 'blank_mode "relay" (cũ) ⇒ cần cầu thư ký, không chạy ngầm');
  assert.equal(s.calls.length, 1);
  const t = await getAdapter('claude-desktop').wake({ staff: 'N', entry: { session: 'local_blank1', sessions_dir: root, blank_prompt: 'Xin chào {name} :: {prompt}' }, prompt: '$& $1', spawnFn: s.fn });
  assert.ok(t.ok && t.blank, '#1022: MẶC ĐỊNH (spawn) phiên trống ⇒ tự tạo phiên, không cầu');
  assert.equal(s.calls[1].stdin, 'Xin chào N :: $& $1');
});

/** spawn giả trả JSON có session_id (như claude -p --output-format json). */
function fakeSpawnSid(sid) {
  const calls = [];
  const fn = (bin, args, opts) => {
    const child = new EventEmitter(); child.pid = 4243; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let stdin = ''; child.stdin = Object.assign(new EventEmitter(), { end(x) { stdin = x ?? ''; setImmediate(() => { child.stdout.emit('data', Buffer.from(`{"type":"result","session_id":"${sid}"}`)); child.emit('close', 0); }); } });
    child.kill = () => {}; calls.push({ bin, args, opts, get stdin() { return stdin; } });
    return child;
  };
  return { fn, calls };
}

test('#1022 phiên ghim trống/mất/quá ngưỡng ⇒ TỰ TẠO phiên mới (tên NV, model roles.json, /staff <slug> <thẻ>); cùng thẻ ⇒ --resume phiên tự tạo; thẻ khác ⇒ phiên mới', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spawn-')); const dir = join(root, 'a', 'o'); mkdirSync(dir, { recursive: true });
  const proj = mkdtempSync(join(tmpdir(), 'proj-')); mkdirSync(join(proj, 'D--x'), { recursive: true });
  const spawnDir = mkdtempSync(join(tmpdir(), 'spd-'));
  writeFileSync(join(dir, 'local_b.json'), JSON.stringify({ sessionId: 'local_b', cwd: 'D:\proj', priorCliSessionIds: ['cu-1'] }));
  writeFileSync(join(dir, 'local_heavy.json'), JSON.stringify({ sessionId: 'local_heavy', cliSessionId: 'cli-heavy', cwd: 'D:\proj' }));
  writeFileSync(join(proj, 'D--x', 'cli-heavy.jsonl'), JSON.stringify({ message: { usage: { input_tokens: 10, cache_read_input_tokens: 300000 } } }) + '\n');
  const roles = join(root, 'roles.json'); writeFileSync(roles, JSON.stringify({ 'DEV PLATFORM': { playbooks: ['platform-security'], model: 'claude-opus-5-5' }, NV1: { playbooks: [], model: 'claude-sonnet-5-5' } }));
  assert.deepEqual(roleOf('DEV PLATFORM', { roles_file: roles }), { model: 'claude-opus-5-5', slug: 'platform-security' });
  assert.deepEqual(roleOf('NV1', { roles_file: roles }), { model: 'claude-sonnet-5-5', slug: 'nv1' });
  assert.equal(roleOf('NV1', { roles_file: roles, model: 'x y' }).model, null, 'model không an toàn ⇒ bỏ');
  const base = { session: 'local_b', sessions_dir: root, roles_file: roles, spawn_dir: spawnDir, projects_dir: proj, args: ['--permission-mode', 'bypassPermissions'] };
  const ad = getAdapter('claude-desktop');

  // (3) phiên trống ⇒ phiên mới, có tên + model + bypass; lời nhắc mở đầu /staff
  const s1 = fakeSpawnSid('sp-111');
  const r1 = await ad.wake({ staff: 'DEV PLATFORM', entry: base, prompt: 'giao thẻ', events: [{ task: '162801#5', kind: 'assign' }], spawnFn: s1.fn });
  assert.ok(r1.ok && r1.blank); assert.ok(r1.detail.includes("TỰ TẠO phiên mới (claude-opus-5-5) cho thẻ 162801#5"), r1.detail);
  assert.deepEqual(s1.calls[0].args, ['-p', '--output-format', 'json', '--name', 'DEV-PLATFORM-5', '--model', 'claude-opus-5-5', '--permission-mode', 'bypassPermissions']);
  assert.equal(s1.calls[0].opts.cwd, 'D:\proj');
  assert.ok(s1.calls[0].stdin.startsWith('/staff platform-security 162801#5\n'), s1.calls[0].stdin.slice(0, 60));
  assert.equal((await r1.running).session_id, 'sp-111');
  assert.equal(loadSpawn('DEV PLATFORM', base).session, 'sp-111'); assert.equal(loadSpawn('DEV PLATFORM', base).card, '162801#5');

  // chưa có tệp hội thoại của phiên tự tạo ⇒ không --resume mù, tạo mới
  const s2 = fakeSpawnSid('sp-222');
  await (await ad.wake({ staff: 'DEV PLATFORM', entry: base, prompt: 'bình luận', events: [{ task: '162801#5', kind: 'comment' }], spawnFn: s2.fn })).running;
  assert.ok(!s2.calls[0].args.includes('--resume'));
  // có tệp hội thoại + cùng thẻ ⇒ --resume phiên tự tạo (giữ ngữ cảnh), lời nhắc thường (không /staff lại)
  writeFileSync(join(proj, 'D--x', 'sp-222.jsonl'), JSON.stringify({ message: { usage: { input_tokens: 5000 } } }) + '\n');
  const s3 = fakeSpawnSid('khong-dung');
  const r3 = await ad.wake({ staff: 'DEV PLATFORM', entry: base, prompt: 'bình luận 2', events: [{ task: '162801#5', kind: 'comment' }], spawnFn: s3.fn });
  assert.deepEqual(s3.calls[0].args, ['--resume', 'sp-222', '-p', '--output-format', 'json', '--model', 'claude-opus-5-5', '--permission-mode', 'bypassPermissions']);
  assert.equal(s3.calls[0].stdin, 'bình luận 2'); assert.match(r3.detail, /--resume phiên tự tạo sp-222/);
  assert.ok(ad.activeAgoMs(base, 'DEV PLATFORM') < 10_000, 'phiên ghim trống ⇒ tuổi = phiên tự tạo (daemon không chạy song song)');
  // thẻ KHÁC ⇒ phiên mới
  const s4 = fakeSpawnSid('sp-333');
  await ad.wake({ staff: 'DEV PLATFORM', entry: base, prompt: 'thẻ mới', events: [{ task: '162801#6', kind: 'assign' }], spawnFn: s4.fn });
  assert.ok(!s4.calls[0].args.includes('--resume')); assert.ok(s4.calls[0].stdin.startsWith('/staff platform-security 162801#6'));

  // tệp phiên ghim MẤT (xoá / đổi tài khoản) mà có cwd ⇒ vẫn tự tạo
  const s5 = fakeSpawnSid('sp-444');
  const r5 = await ad.wake({ staff: 'NV1', entry: { ...base, session: 'local_mat', cwd: 'D:\proj' }, prompt: 'p', events: [{ task: '162801#7' }], spawnFn: s5.fn });
  assert.ok(r5.ok); assert.match(r5.detail, /không còn trong ứng dụng/); assert.ok(s5.calls[0].stdin.startsWith('/staff nv1 162801#7'));

  // #1045: NV theo manifest KHÔNG khai session (hoặc tệp local_*.json đã bị đổi tên/xoá) ⇒ vẫn thức bằng phiên tự tạo
  const sN = fakeSpawnSid('sp-545');
  const rN = await ad.wake({ staff: 'NV1', entry: { ...base, session: undefined, cwd: 'D:\proj' }, prompt: 'p', events: [{ task: '162801#9' }], spawnFn: sN.fn });
  assert.ok(rN.ok); assert.ok(sN.calls[0].stdin.startsWith('/staff nv1 162801#9'));
  assert.equal((await ad.wake({ staff: 'NV1', entry: { ...base, session: undefined, cwd: undefined }, prompt: 'p', events: [], spawnFn: sN.fn })).ok, false);

  // phiên ghim QUÁ NGƯỠNG ⇒ để yên, tạo phiên mới (không cầu dọn); allow_large ⇒ --resume như cũ
  const s6 = fakeSpawnSid('sp-555');
  const r6 = await ad.wake({ staff: 'NV1', entry: { ...base, session: 'local_heavy', max_context_tokens: 250000 }, prompt: 'p', events: [{ task: '162801#8' }], spawnFn: s6.fn });
  assert.ok(r6.ok); assert.match(r6.detail, /không --resume phiên ghim .*TỰ TẠO/); assert.ok(!s6.calls[0].args.includes('cli-heavy'));
  const s7 = fakeSpawnSid('x');
  await ad.wake({ staff: 'NV1', entry: { ...base, session: 'local_heavy', max_context_tokens: 250000, allow_large: true }, prompt: 'p', events: [{ task: '162801#8' }], spawnFn: s7.fn });
  assert.deepEqual(s7.calls[0].args.slice(0, 5), ['--resume', 'cli-heavy', '-p', '--output-format', 'json']);
  // relay ⇒ quá ngưỡng vẫn chặn như cũ
  const r8 = await ad.wake({ staff: 'NV1', entry: { ...base, session: 'local_heavy', max_context_tokens: 250000, blank_mode: 'relay' }, prompt: 'p', events: [{ task: '162801#8' }], spawnFn: s7.fn });
  assert.equal(r8.ok, false); assert.equal(r8.blocked, true);
});

test('#872 nợ 5: mọi tiến trình con của agentd mang DBIO_AGENTD_TURN=1; lời nhắc mặc định cấm bật listen/watch nền', async () => {
  const { runChild } = await import('../lib/agentd/adapters/util.mjs');
  const { DEFAULT_TEMPLATE } = await import('../lib/agentd/rules.mjs');
  let seen; const spawnFn = (bin, args, o) => { seen = o.env; return { pid: 1, stdout: null, stderr: null, stdin: { on() {}, end() {} }, on() {} }; };
  runChild({ bin: process.execPath, args: [], spawnFn });
  assert.equal(seen.DBIO_AGENTD_TURN, '1');
  assert.ok(!/chạy lại lệnh nền/.test(DEFAULT_TEMPLATE) && /KHÔNG bật listen/.test(DEFAULT_TEMPLATE));
});

test('#872 nợ 6: activeAgoMs lấy MIN(tệp hội thoại, lastActivityAt của ứng dụng) — lượt đang chạy công cụ lâu (tệp cũ) vẫn bị coi là bận', () => {
  const root = mkdtempSync(join(tmpdir(), 'act6-')); const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'local_act6.json'), JSON.stringify({ sessionId: 'local_act6', cliSessionId: 'act-cli-6', lastActivityAt: Date.now() - 5000 }));
  const proj = join(root, 'proj'); mkdirSync(join(proj, 'p'), { recursive: true }); const f = join(proj, 'p', 'act-cli-6.jsonl'); writeFileSync(f, '{}\n');
  const old = new Date(Date.now() - 3_600_000); utimesSync(f, old, old);
  const ms = getAdapter('claude-desktop').activeAgoMs({ session: 'local_act6', sessions_dir: root, projects_dir: proj });
  assert.ok(ms != null && ms < 20_000, `ms=${ms}`);
});

// ===== #965: allowed_tools =====
import { allowedToolsArgs, UNSAFE_TOOLARG } from '../lib/agentd/adapters/util.mjs';
import { boardOf } from '../lib/common.mjs';
import { installPlan } from '../lib/agentd/service.mjs';

test('#965 allowed_tools: mảng/chuỗi ⇒ một cặp --allowedTools; ngoặc/sao/hai chấm đi được, ký tự shell bị chặn', () => {
  assert.deepEqual(allowedToolsArgs(['Bash(dbio-staff:*)', 'Read']), ['--allowedTools', 'Bash(dbio-staff:*),Read']);
  assert.deepEqual(allowedToolsArgs('Bash(dbio-staff:*),Read'), ['--allowedTools', 'Bash(dbio-staff:*),Read']);
  assert.deepEqual(allowedToolsArgs(undefined), []);
  for (const bad of ['Bash(x;rm)', 'Bash(a|b)', 'Bash($(x))', '-p', 'Bash(x) y']) assert.throws(() => allowedToolsArgs([bad]), /allowed_tools/, bad);
  assert.ok(UNSAFE_TOOLARG.test('a"b') && UNSAFE_TOOLARG.test('a&b'));
});

test('#965 allowed_tools: runChild truyền nguyên cặp sau args (không qua SAFE_ARG)', () => {
  let seen;
  const fake = (exe, args) => { seen = args; return { pid: 1, stdout: { on() {} }, stderr: { on() {} }, stdin: { on() {}, end() {} }, on() {} }; };
  const r = runChild({ bin: 'claude', args: ['-p'], toolArgs: allowedToolsArgs(['Bash(dbio-staff:*)']), spawnFn: fake, logName: 't965' });
  assert.ok(r.ok);
  assert.equal(seen[0], '-p'); assert.equal(seen[1], '--allowedTools'); assert.ok(seen[2].includes('Bash(dbio-staff:*)'));
  assert.equal(runChild({ bin: 'claude', toolArgs: ['--allowedTools', 'a"b'], spawnFn: fake }).ok, false);
});

test('#965 plist/launcher/unit KHÔNG chép token hay khoá vào env dịch vụ', () => {
  const env = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-x', ANTHROPIC_API_KEY: 'k', DBIO_AGENTD_CONFIG: '/c.json' };
  for (const platform of ['darwin', 'win32', 'linux']) {
    const p = installPlan({ platform, node: '/n', script: '/s', home: '/h', env });
    const all = p.files.map((f) => f.content).join('\n');
    assert.ok(!/sk-x|OAUTH|ANTHROPIC/.test(all), platform);
  }
});

test('#965 sổ cái: khoá.board ưu tiên hơn DBIO_BOARD mặc định máy, --board ưu tiên nhất', () => {
  assert.equal(boardOf({}, { board: 165501 }, { DBIO_BOARD: '162801' }), 165501);
  assert.equal(boardOf({ board: 7 }, { board: 165501 }, { DBIO_BOARD: '162801' }), 7);
  assert.equal(boardOf({}, {}, { DBIO_BOARD: '162801' }), 162801);
  assert.equal(boardOf({}, null, {}), null);
});

test('#965 keyFile: store số ⇒ <tên>@s<store>.json (không ghi đè khoá store nhà); không store ⇒ tên trần', async () => {
  const { keyFile } = await import('../lib/common.mjs');
  assert.match(keyFile('Mimi'), /Mimi\.json$/);
  assert.match(keyFile('Mimi', 4), /Mimi@s4\.json$/);
  assert.match(keyFile('Mimi', '4'), /Mimi@s4\.json$/);
  assert.match(keyFile('Mimi', null), /Mimi\.json$/);
  assert.match(keyFile('Mimi', 'x/../y'), /Mimi\.json$/);
});

test('#1036 kiểm phiên bản CLI ↔ model: CLI cũ hơn model cần ⇒ chặn trước spawn, báo đỏ; đủ/không biết ⇒ cho qua', async () => {
  const { checkCliModel, cmpVer, minCliFor } = await import('../lib/agentd/cli-version.mjs');
  assert.equal(cmpVer('2.1.296', '2.1.280'), 1); assert.equal(cmpVer('2.1.278', '2.1.280'), -1); assert.equal(cmpVer('2.1.280', '2.1.280'), 0);
  assert.equal(minCliFor('claude-opus-5-5'), '2.1.280'); assert.equal(minCliFor('claude-sonnet-5-5'), null); assert.equal(minCliFor('claude-x-9', { 'x-9': '3.0.0' }), '3.0.0');
  const old = checkCliModel({ model: 'claude-opus-5-5', getVersion: () => '2.1.278' });
  assert.equal(old.ok, false); assert.match(old.detail, /2\.1\.278.*claude-opus-5-5.*≥ 2\.1\.280/);
  assert.equal(checkCliModel({ model: 'claude-opus-5-5', getVersion: () => '2.1.296' }).ok, true);
  assert.equal(checkCliModel({ model: 'claude-opus-5-5', getVersion: () => null }).ok, true, 'không biết phiên bản ⇒ không chặn oan');
  assert.equal(checkCliModel({ model: 'claude-sonnet-5-5', getVersion: () => '1.0.0' }).ok, true);
});

test('#1036 bestClaudeBin: chọn CLI MỚI NHẤT giữa app Desktop và PATH; dò thư mục claude-code/<ver>/<băm>/', async () => {
  const { appCliCandidates, bestClaudeBin } = await import('../lib/agentd/cli-version.mjs');
  const la = mkdtempSync(join(tmpdir(), 'la-')); const base = join(la, 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'Claude', 'claude-code');
  for (const [v, h] of [['2.1.288', 'aa'], ['2.1.295', 'bb']]) { mkdirSync(join(base, v, h), { recursive: true }); writeFileSync(join(base, v, h, 'claude.exe'), ''); }
  mkdirSync(join(base, 'junk', 'zz'), { recursive: true });
  const c = appCliCandidates({ env: { LOCALAPPDATA: la }, home: la, plat: 'win32' });
  assert.deepEqual(c.map((x) => x.version).sort(), ['2.1.288', '2.1.295']);
  assert.equal(bestClaudeBin({ candidates: c, getVersion: () => '2.1.278' }).version, '2.1.295');
  assert.equal(bestClaudeBin({ candidates: c, getVersion: () => '2.1.300' }).source, 'path');
  assert.equal(bestClaudeBin({ candidates: [], getVersion: () => null }), null);
});

test('#1036 runChild: Windows KHÔNG detached (claude.cmd chết mã 1 khi detached); nơi khác detached để tách nhóm tiến trình', async () => {
  const s = fakeSpawn();
  const r = runChild({ bin: 'node', args: ['-v'], spawnFn: s.fn, logName: 'detached-test' });
  await r.running;
  assert.equal(s.calls[0].opts.detached, process.platform !== 'win32');
});

test('runChild #1036 (d): đã in JSON kết quả mà tiến trình không thoát ⇒ sau ân hạn giết + coi XONG (Run luôn đóng)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'res-')); const f = join(d, 'res.mjs');
  writeFileSync(f, 'console.log(JSON.stringify({type:"result",is_error:false,usage:{}})); setTimeout(() => {}, 60000);');
  const r = runChild({ bin: process.execPath, args: [f], input: '', timeoutS: 30, resultGraceS: 0.3 });
  const t0 = Date.now(); const x = await r.running;
  assert.ok(Date.now() - t0 < 5000); assert.equal(x.code, 0); assert.equal(x.forced, true); assert.equal(x.timedOut, false);
});
