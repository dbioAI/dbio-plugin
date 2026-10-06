import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLAYBOOK_TTL_MS, STATUS_TTL_MS, buildIdentity, cacheFile, identityLine, resolveWho, sessionByCli } from '../lib/identity.mjs';

const NOW = 1_800_000_000_000;
const mem = () => { const m = new Map(); return { readCache: (f) => m.get(f) ?? null, writeCache: (f, o) => m.set(f, JSON.parse(JSON.stringify(o))), m }; };

test('identityLine: có vai/playbook/thẻ; câu GHI ĐÈ + không hỏi lại; tên phiên lệch ⇒ nêu rõ', () => {
  const l = identityLine({ who: 'DEV A', playbooks: ['playbook-luat-phong', 'playbook-dev-a'], task: '1001#857', state: 'working' });
  assert.match(l, /Bạn là "DEV A"/); assert.match(l, /luat-phong \+ dev-a/); assert.match(l, /1001#857 \(working\)/); assert.match(l, /GHI ĐÈ/); assert.match(l, /không hỏi lại/);
  assert.ok(!/lệch/.test(l));
  assert.match(identityLine({ who: 'DEV A', title: 'TỐI ƯU PAGE WEB', playbooks: [], task: null }), /tên phiên "TỐI ƯU PAGE WEB" lệch/);
  assert.match(identityLine({ who: 'X', playbooks: [], task: null }), /\(chưa gắn\).*không$|thẻ đang cầm: không/);
  assert.equal(identityLine(null), '');
});

test('sessionByCli: tìm tên phiên theo cliSessionId; không có ⇒ null', () => {
  const tree = { '/r': [['acc', true]], '/r/acc': [['org', true]], '/r/acc/org': [['local_1.json', false], ['local_2.json', false], ['note.txt', false]] };
  const ls = (d) => (tree[d.replace(/\\/g, '/')] ?? []).map(([name, dir]) => ({ name, isDirectory: () => dir }));
  const read = (f) => (f.endsWith('local_1.json') ? { id: 'local_1', cli: 'c1', title: 'PM  Lead' } : { id: 'local_2', cli: 'c2', title: 'DEV A' });
  assert.deepEqual(sessionByCli('c2', { root: '/r', ls, read }), { title: 'DEV A', id: 'local_2' });
  assert.deepEqual(sessionByCli('c1', { root: '/r', ls, read }), { title: 'PM Lead', id: 'local_1' });
  assert.equal(sessionByCli('zz', { root: '/r', ls, read }), null);
  assert.equal(sessionByCli('c1', { root: null }), null);
  assert.equal(sessionByCli(undefined, { root: '/r', ls, read }), null);
});

test('resolveWho: env > bản nhớ (tên phiên không đổi) > tên phiên có khoá; tên phiên đổi ⇒ bỏ bản nhớ', () => {
  const home = '/h';
  assert.deepEqual(resolveWho({ cliId: 'c', env: { DBIO_STAFF: 'E' }, home, session: () => ({ title: 'T' }) }), { who: 'E', title: null, source: 'env' });
  const cache = { who: 'C', title: 'T' };
  assert.equal(resolveWho({ cliId: 'c', env: {}, home, session: () => ({ title: 'T' }), hasKey: () => true, readCache: () => cache }).who, 'C');
  assert.equal(resolveWho({ cliId: 'c', env: {}, home, session: () => ({ title: 'T2' }), hasKey: () => true, readCache: () => cache }).who, 'T2');
  assert.equal(resolveWho({ cliId: 'c', env: {}, home, session: () => ({ title: 'T2' }), hasKey: () => false, readCache: () => cache }), null);
  assert.equal(resolveWho({ cliId: 'c', env: {}, home, session: () => null, hasKey: () => true, readCache: () => cache }).who, 'C');
  assert.equal(resolveWho({ cliId: 'c', env: {}, home, session: () => null, hasKey: () => true, readCache: () => null }), null);
});

test('buildIdentity: gọi máy chủ lần đầu; trong TTL dùng bản nhớ (0 lệnh gọi); hết TTL gọi lại; playbook nhớ lâu hơn', async () => {
  const { readCache, writeCache } = mem(); let st = 0; let pb = 0;
  const deps = { cliId: 'c', resolve: () => ({ who: 'A', title: 'A', source: 'title' }), fetchStatus: async () => { st++; return { state: 'working', task: '1#2' }; }, fetchPlaybooks: async () => { pb++; return ['playbook-x']; }, readCache, writeCache };
  const r1 = await buildIdentity({ ...deps, now: NOW });
  assert.match(r1.line, /thẻ đang cầm: 1#2/); assert.deepEqual([st, pb], [1, 1]);
  await buildIdentity({ ...deps, now: NOW + 5_000 }); assert.deepEqual([st, pb], [1, 1]);
  await buildIdentity({ ...deps, now: NOW + STATUS_TTL_MS + 1 }); assert.deepEqual([st, pb], [2, 1]);
  await buildIdentity({ ...deps, now: NOW + PLAYBOOK_TTL_MS + 1 }); assert.deepEqual([st, pb], [3, 2]);
});

test('buildIdentity: máy chủ lỗi ⇒ dùng bản nhớ cũ + đánh dấu cũ; chưa có bản nhớ ⇒ vẫn có dòng vai (thẻ không rõ); đổi vai ⇒ không dùng bản nhớ của vai cũ', async () => {
  const { readCache, writeCache } = mem(); const bad = async () => { throw new Error('mạng'); };
  const base = { cliId: 'c', resolve: () => ({ who: 'A', title: 'A', source: 'title' }), readCache, writeCache };
  const first = await buildIdentity({ ...base, fetchStatus: bad, fetchPlaybooks: bad, now: NOW });
  assert.match(first.line, /CHƯA xác nhận/); assert.ok(!/không hỏi lại|GHI ĐÈ/.test(first.line)); assert.match(first.line, /"A"/);
  await buildIdentity({ ...base, fetchStatus: async () => ({ state: 'idle', task: '9#9' }), fetchPlaybooks: async () => ['p'], now: NOW + 1 });
  const stale = await buildIdentity({ ...base, fetchStatus: bad, fetchPlaybooks: bad, now: NOW + STATUS_TTL_MS * 2 });
  assert.match(stale.line, /9#9/); assert.match(stale.line, /có thể cũ/);
  const other = await buildIdentity({ ...base, resolve: () => ({ who: 'B', title: 'B', source: 'title' }), fetchStatus: async () => ({ state: 'idle', task: null }), fetchPlaybooks: async () => [], now: NOW + STATUS_TTL_MS * 3 });
  assert.match(other.line, /Bạn là "B"/); assert.ok(!/9#9/.test(other.line));
});

test('buildIdentity: không nhận diện được vai ⇒ line rỗng', async () => {
  assert.deepEqual(await buildIdentity({ resolve: () => null }), { line: '', info: null });
});

test('cacheFile: tên an toàn theo phiên', () => assert.match(cacheFile('a/b..c').replace(/\\/g, '/'), /\.dbio\/identity\/a_b__c\.json$/));

test('HOOK thật (UserPromptSubmit) với MCP giả: in additionalContext có vai + playbook + thẻ; KHÔNG in khoá; vai lệch tên phiên ⇒ máy chủ thắng', async () => {
  const KEY = 'sk_FAKEKEYVALUE0123456789';
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const a = JSON.parse(b).params.arguments; let out = {};
      if (a.action === 'staff_status') out = { staff: { name: a.who, state: 'working', task: { ref: '1001#857' } } };
      else if (a.action === 'staff_playbook') out = { playbooks: [{ slug: 'playbook-luat' }, { slug: 'playbook-dev-a' }] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ success: true, ...out }) }] } }));
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const home = mkdtempSync(join(tmpdir(), 'idh-'));
  try {
    mkdirSync(join(home, '.dbio', 'staff-keys'), { recursive: true });
    writeFileSync(join(home, '.dbio', 'staff-keys', 'DEV_A.json'), JSON.stringify({ key: KEY, mcp_url: `http://127.0.0.1:${srv.address().port}/mcp`, store_id: 1 }));
    const HOOK = fileURLToPath(new URL('../hooks/identity.mjs', import.meta.url));
    const run = (event) => new Promise((ok) => {
      const c = spawn(process.execPath, [HOOK], { env: { ...process.env, USERPROFILE: home, HOME: home, DBIO_STAFF: 'DEV A' } });
      let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
      c.on('close', (code) => ok({ code, out, err }));
      c.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'cli-1' }));
    });
    const r = await run('UserPromptSubmit');
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out); assert.equal(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const t = j.hookSpecificOutput.additionalContext;
    assert.match(t, /Bạn là "DEV A"/); assert.match(t, /luat \+ dev-a/); assert.match(t, /1001#857/); assert.ok(!t.includes(KEY));
    assert.ok(JSON.parse(readFileSync(cacheFile('cli-1', home), 'utf8')).who === 'DEV A'); // bản nhớ theo phiên
    const r2 = await run('SessionStart'); assert.equal(JSON.parse(r2.out).hookSpecificOutput.hookEventName, 'SessionStart');
    // JSON hỏng ⇒ im lặng, thoát 0
    const bad = await new Promise((ok) => { const c = spawn(process.execPath, [HOOK], { env: { ...process.env, HOME: home, USERPROFILE: home } }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', (code) => ok({ code, o })); c.stdin.end('không phải json'); });
    assert.deepEqual(bad, { code: 0, o: '' });
  } finally { srv.close(); rmSync(home, { recursive: true, force: true }); }
});

test('HOOK: chưa nhận diện được vai ⇒ UserPromptSubmit im lặng; SessionStart nhắc bootstrap', async () => {
  const home = mkdtempSync(join(tmpdir(), 'idh-'));
  try {
    const HOOK = fileURLToPath(new URL('../hooks/identity.mjs', import.meta.url));
    const run = (event) => new Promise((ok) => {
      const env = { ...process.env, USERPROFILE: home, HOME: home }; delete env.DBIO_STAFF;
      const c = spawn(process.execPath, [HOOK], { env }); let out = ''; c.stdout.on('data', (d) => { out += d; });
      c.on('close', (code) => ok({ code, out })); c.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'nope' }));
    });
    assert.deepEqual(await run('UserPromptSubmit'), { code: 0, out: '' });
    const s = await run('SessionStart'); assert.match(JSON.parse(s.out).hookSpecificOutput.additionalContext, /bootstrap/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('buildIdentity: máy chủ gọi người này bằng TÊN KHÁC ⇒ theo máy chủ, nêu lệch', async () => {
  const { readCache, writeCache } = mem();
  const r = await buildIdentity({ cliId: 'c', resolve: () => ({ who: 'TỐI ƯU PAGE WEB', title: 'TỐI ƯU PAGE WEB', source: 'title' }), fetchStatus: async () => ({ state: 'working', task: '1#2', name: 'DEV WEB' }), fetchPlaybooks: async () => ['playbook-x'], readCache, writeCache, now: NOW });
  assert.match(r.line, /Bạn là "DEV WEB"/); assert.match(r.line, /tên phiên "TỐI ƯU PAGE WEB" lệch/); assert.match(r.line, /GHI ĐÈ/);
  const same = await buildIdentity({ cliId: 'd', resolve: () => ({ who: 'dev  web', title: null, source: 'env' }), fetchStatus: async () => ({ state: 'idle', task: null, name: 'DEV WEB' }), fetchPlaybooks: async () => [], readCache, writeCache, now: NOW });
  assert.ok(!/lệch/.test(same.line)); // chỉ khác hoa/thường/khoảng trắng ⇒ không phải lệch
});

test('identityLine: unconfirmed ⇒ không khẳng định, không câu "không hỏi lại"', () => {
  const l = identityLine({ who: 'A', unconfirmed: true, playbooks: ['p'], task: null });
  assert.match(l, /CHƯA xác nhận/); assert.ok(!/GHI ĐÈ|không hỏi lại/.test(l));
});

test('HOOK chạy ĐÔI (cài cả plugin lẫn dbio-internal) ⇒ chỉ MỘT bản in', async () => {
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const a = JSON.parse(b).params.arguments; const out = a.action === 'staff_status' ? { staff: { name: a.who, state: 'idle', task: null } } : { playbooks: [] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ success: true, ...out }) }] } }));
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const home = mkdtempSync(join(tmpdir(), 'idh-'));
  try {
    mkdirSync(join(home, '.dbio', 'staff-keys'), { recursive: true });
    writeFileSync(join(home, '.dbio', 'staff-keys', 'DEV_A.json'), JSON.stringify({ key: 'sk_FAKEKEYVALUE0123456789', mcp_url: `http://127.0.0.1:${srv.address().port}/mcp`, store_id: 1 }));
    const HOOK = fileURLToPath(new URL('../hooks/identity.mjs', import.meta.url));
    const one = () => new Promise((ok) => { const c = spawn(process.execPath, [HOOK], { env: { ...process.env, USERPROFILE: home, HOME: home, DBIO_STAFF: 'DEV A' } }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', () => ok(o)); c.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'dup-1' })); });
    const outs = await Promise.all([one(), one()]);
    assert.equal(outs.filter((o) => o.includes('Bạn là')).length, 1, JSON.stringify(outs));
  } finally { srv.close(); rmSync(home, { recursive: true, force: true }); }
});
