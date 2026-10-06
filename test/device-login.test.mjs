import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deviceLogin, originOf, saveKey, tail4, validKeyPayload } from '../lib/device-login.mjs';
import { extractSkill, skillsDir, validSkill, writeSkill } from '../lib/skills-install.mjs';

const KEY = 'sk_FAKEKEYVALUE0123456789';
const fakeFetch = (script) => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); const r = script.shift(); return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => JSON.stringify(r.json) }; };
  f.calls = calls;
  return f;
};
const noSleep = async () => {};
const FENCE = '```';

test('originOf: lấy origin từ mcp_url', () => assert.equal(originOf('https://mcp.example.com/mcp'), 'https://mcp.example.com'));

test('tail4 / validKeyPayload', () => {
  assert.equal(tail4(KEY), '6789');
  assert.equal(validKeyPayload({ key: KEY, mcp_url: 'https://x/mcp' }), true);
  assert.equal(validKeyPayload({ key: 'short', mcp_url: 'https://x/mcp' }), false);
  assert.equal(validKeyPayload({ key: KEY, mcp_url: 'http://x/mcp' }), false);
  assert.equal(validKeyPayload({ key: KEY, mcp_url: 'http://127.0.0.1:9/mcp' }), true);
  assert.equal(validKeyPayload({ key: KEY, mcp_url: 'https://evil.example.net/mcp' }, 'https://mcp.example.com/mcp'), false);
  assert.equal(validKeyPayload({ key: KEY, mcp_url: 'https://mcp.example.com/other' }, 'https://mcp.example.com/mcp'), true);
  assert.equal(validKeyPayload(null), false);
});

test('deviceLogin: pending → ok ⇒ ghi tệp khoá (0600), KHÔNG in giá trị khoá', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-')); const file = join(dir, 'keys', 'A.json'); const said = [];
  try {
    const f = fakeFetch([{ json: { code: 'ABCD-EFGH', poll_secret: 'ps1', interval: 1 } }, { json: { status: 'pending' } }, { json: { status: 'ok', key: KEY, mcp_url: 'https://mcp.example.com/mcp', store_id: 7, board: 9 } }]);
    const r = await deviceLogin({ fetchFn: f, mcpUrl: 'https://mcp.example.com/mcp', who: 'A', file, say: (l) => said.push(l), sleep: noSleep });
    assert.deepEqual(r, { ok: true, tail: '6789' });
    const j = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(j.key, KEY); assert.equal(j.board, 9); assert.equal(j.who, 'A');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!said.join('\n').includes(KEY)); assert.match(said[0], /ABCD-EFGH/);
    assert.equal(f.calls[0].url, 'https://mcp.example.com/device/start');
    assert.deepEqual(f.calls[1].body, { code: 'ABCD-EFGH', poll_secret: 'ps1' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deviceLogin: denied / expired ⇒ ok:false; không ghi tệp', async () => {
  for (const status of ['denied', 'expired']) {
    const dir = mkdtempSync(join(tmpdir(), 'dl-')); const file = join(dir, 'A.json');
    try {
      const r = await deviceLogin({ fetchFn: fakeFetch([{ json: { code: 'C', poll_secret: 'p' } }, { json: { status } }]), who: 'A', file, say() {}, sleep: noSleep });
      assert.deepEqual(r, { ok: false, reason: status });
      assert.throws(() => statSync(file));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('deviceLogin: quá hạn chờ ⇒ timeout', async () => {
  let t = 0;
  const script = [{ json: { code: 'C', poll_secret: 'p' } }, ...Array.from({ length: 5 }, () => ({ json: { status: 'pending' } }))];
  const r = await deviceLogin({ fetchFn: fakeFetch(script), who: 'A', file: join(tmpdir(), 'never.json'), say() {}, sleep: noSleep, now: () => (t += 400_000), maxWaitMs: 600_000 });
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
});

test('deviceLogin: máy chủ trả khoá hỏng ⇒ lỗi, không ghi', async () => {
  await assert.rejects(deviceLogin({ fetchFn: fakeFetch([{ json: { code: 'C', poll_secret: 'p' } }, { json: { status: 'ok', key: 'x', mcp_url: 'https://a/mcp' } }]), who: 'A', file: join(tmpdir(), 'never2.json'), say() {}, sleep: noSleep }), /không hợp lệ/);
});

test('deviceLogin: máy chủ chưa hỗ trợ (thiếu code) / lỗi HTTP ⇒ ném', async () => {
  await assert.rejects(deviceLogin({ fetchFn: fakeFetch([{ json: {} }]), who: 'A', file: 'x', say() {}, sleep: noSleep }), /không trả mã/);
  await assert.rejects(deviceLogin({ fetchFn: fakeFetch([{ ok: false, status: 429, json: { error: 'rate_limited' } }]), who: 'A', file: 'x', say() {}, sleep: noSleep }), /rate_limited/);
});

test('saveKey: không ghi trường rỗng', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-')); const f = join(dir, 'a.json');
  try {
    saveKey(f, { key: KEY, mcp_url: 'https://a/mcp' }, 'A');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(f, 'utf8'))).sort(), ['key', 'mcp_url', 'who']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const SK = '---\nname: pm\ndescription: Vai PM\n---\n\n# PM\nnội dung\n';

test('extractSkill: lấy khối đầu; hỗ trợ hàng rào dài hơn khi skill chứa khối code', () => {
  assert.equal(extractSkill(`Tổng quan\n\n${FENCE}markdown\n${SK}${FENCE}\n\nhết`), SK);
  const inner = `${SK}\n${FENCE}bash\nls\n${FENCE}\n`;
  assert.equal(extractSkill(`x\n\n\`\`\`\`markdown\n${inner}\`\`\`\`\n`), inner);
  assert.equal(extractSkill('không có khối'), null);
});

test('validSkill: cần frontmatter name + description', () => {
  assert.equal(validSkill(SK), true);
  assert.equal(validSkill('# PM\nkhông frontmatter'), false);
  assert.equal(validSkill('---\nname: pm\n---\nx'), false);
});

test('writeSkill: ghi ~/.claude/skills/<tên>/SKILL.md dưới HOME giả', () => {
  const home = mkdtempSync(join(tmpdir(), 'sk-'));
  try {
    const f = writeSkill('pm', SK, home);
    assert.equal(f, join(skillsDir(home), 'pm', 'SKILL.md'));
    assert.equal(readFileSync(f, 'utf8'), SK);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLI login thật với máy chủ HTTP giả: ghi khoá, in 4 ký tự cuối, không lộ khoá', async () => {
  let polls = 0;
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/device/start') res.end(JSON.stringify({ code: 'WXYZ-1234', poll_secret: 's', interval: 1 }));
      else if (req.url === '/device/poll') res.end(JSON.stringify(++polls < 2 ? { status: 'pending' } : { status: 'ok', key: KEY, mcp_url: `http://127.0.0.1:${srv.address().port}/mcp`, board: 5 }));
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const home = mkdtempSync(join(tmpdir(), 'cli-'));
  try {
    const BIN = fileURLToPath(new URL('../bin/dbio-staff.mjs', import.meta.url));
    const child = spawn(process.execPath, [BIN, 'login', '--as', 'Máy Thử', '--mcp', `http://127.0.0.1:${srv.address().port}/mcp`], { env: { ...process.env, USERPROFILE: home, HOME: home } });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((ok) => child.on('close', ok));
    assert.equal(code, 0, out); assert.match(out, /WXYZ-1234/); assert.match(out, /…6789/); assert.ok(!out.includes(KEY));
    const j = JSON.parse(readFileSync(join(home, '.dbio', 'staff-keys', 'Máy_Thử.json'), 'utf8'));
    assert.equal(j.key, KEY); assert.equal(j.board, 5);
  } finally { srv.close(); rmSync(home, { recursive: true, force: true }); }
});

test('deviceLogin: từ chối địa chỉ http ra Internet; khoá trả về mcp_url KHÁC máy chủ đã hỏi ⇒ lỗi, không ghi', async () => {
  await assert.rejects(deviceLogin({ fetchFn: fakeFetch([]), mcpUrl: 'http://mcp.example.com/mcp', who: 'A', file: 'x', say() {}, sleep: noSleep }), /https/);
  const dir = mkdtempSync(join(tmpdir(), 'dl-')); const file = join(dir, 'A.json');
  try {
    await assert.rejects(deviceLogin({ fetchFn: fakeFetch([{ json: { code: 'C', poll_secret: 'p' } }, { json: { status: 'ok', key: KEY, mcp_url: 'https://evil.example.net/mcp' } }]), mcpUrl: 'https://mcp.example.com/mcp', who: 'A', file, say() {}, sleep: noSleep }), /không hợp lệ/);
    assert.throws(() => statSync(file));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deviceLogin: in máy chủ đang hỏi (để người duyệt đối chiếu)', async () => {
  const said = [];
  await deviceLogin({ fetchFn: fakeFetch([{ json: { code: 'C', poll_secret: 'p' } }, { json: { status: 'denied' } }]), mcpUrl: 'https://mcp.example.com/mcp', who: 'A', file: 'x', say: (l) => said.push(l), sleep: noSleep });
  assert.match(said[0], /mcp\.example\.com/);
});

test('CLI login: đã có khoá ⇒ từ chối (thoát 2), KHÔNG ghi đè', () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-'));
  try {
    const dir = join(home, '.dbio', 'staff-keys'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Cũ.json'), JSON.stringify({ key: 'sk_OLDOLDOLDOLDOLDOLD', mcp_url: 'https://mcp.example.com/mcp' }));
    const BIN = fileURLToPath(new URL('../bin/dbio-staff.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [BIN, 'login', '--as', 'Cũ', '--mcp', 'https://mcp.example.com/mcp'], { env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 2); assert.match(r.stderr, /--force/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'Cũ.json'), 'utf8')).key, 'sk_OLDOLDOLDOLDOLDOLD');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
