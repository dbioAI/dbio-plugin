import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { evt, hello, startFakeServer, waitFor } from './helpers/fake-stream-server.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dbio-staff.mjs');
const KEY = 'sk_p2_abcdefghijklmnopqrstuvwxyz0123456789';

function sandbox(mcpUrl) {
  const home = mkdtempSync(join(tmpdir(), 'listen-home-'));
  mkdirSync(join(home, '.dbio', 'staff-keys'), { recursive: true });
  writeFileSync(join(home, '.dbio', 'staff-keys', 'T.json'), JSON.stringify({ key: KEY, mcp_url: mcpUrl }));
  return { home, env: { ...process.env, HOME: home, USERPROFILE: home, DBIO_STREAM_DIR: join(home, 'stream'), DBIO_WATCH_LOG: join(home, 'watch-log.jsonl') } };
}
const run = (args, env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; const t0 = Date.now();
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
  run.last = p;
});

test('listen: assign tới ⇒ in tin + thoát 0 NGAY (<5s kể từ lúc đẩy), con trỏ + nhịp được ghi, CHƯA ack (chờ phiên xử lý)', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const sb = sandbox(srv.mcpUrl);
  try {
    const p = run(['listen', '--as', 'T', '--max-min', '1', '--coalesce', '0', '--quiet'], sb.env);
    await waitFor(() => srv.conns.length === 1, 8000);
    const t0 = Date.now(); srv.conns[0].send(evt(5, { text: 'PM giao thẻ #861' }));
    const r = await p;
    assert.equal(r.code, 0, r.err);
    assert.ok(Date.now() - t0 < 5000, `thức sau ${Date.now() - t0}ms`);
    assert.match(r.out, /1#5/); assert.match(r.out, /khẩn/);
    assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
    assert.ok(!srv.conns[0].received.some((f) => f.op === 'ack'), 'listen KHÔNG ack ngay (phiên có thể vừa clear) — #872');
    assert.deepEqual(JSON.parse(readFileSync(join(sb.home, 'stream', 'T.listen.pending.json'), 'utf8')).ids, [5], 'id chờ ack lưu đĩa');
    assert.equal(JSON.parse(readFileSync(join(sb.home, 'stream', 'T.listen.cursor.json'), 'utf8')).cursor, 5);
    const beat = JSON.parse(readFileSync(join(sb.home, '.dbio', 'staff-keys', 'T.alive.json'), 'utf8'));
    assert.equal(beat.ended, true); assert.equal(beat.mode, 'listen');
    assert.ok(existsSync(join(sb.home, 'watch-log.jsonl')));
  } finally { await srv.stop(); }
});

test('listen: chạy lại ⇒ không thức lại vì tin đã xử lý (nối bằng since)', async () => {
  const srv = await startFakeServer({ onConnect: (c) => { c.send(hello(0)); c.send(evt(5)); } });
  const sb = sandbox(srv.mcpUrl);
  try {
    const r1 = await run(['listen', '--as', 'T', '--max-min', '1', '--coalesce', '0', '--quiet'], sb.env);
    assert.equal(r1.code, 0);
    const r2 = run(['listen', '--as', 'T', '--max-min', '0.1', '--coalesce', '0', '--quiet'], sb.env);
    await waitFor(() => srv.conns.length === 2, 8000);
    assert.match(srv.conns[1].url, /since=5/);
    srv.conns[1].send(evt(5)); // máy chủ gửi lại tin cũ (giao ít nhất một lần)
    const x = await r2;
    assert.equal(x.code, 3); assert.match(x.out, /hết giờ/);
  } finally { await srv.stop(); }
});

test('listen: khoá thiếu ⇒ thoát 2, thông báo rõ; hết giờ ⇒ 1 dòng + thoát 3', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const sb = sandbox(srv.mcpUrl);
  try {
    const miss = await run(['listen', '--as', 'KHONG_CO', '--max-min', '0.1', '--quiet'], sb.env);
    assert.equal(miss.code, 2); assert.match(miss.err, /Chưa có khoá/);
    const idle = await run(['listen', '--as', 'T', '--max-min', '0.05', '--quiet'], sb.env);
    assert.equal(idle.code, 3); assert.equal(idle.out.trim().split('\n').length, 1);
  } finally { await srv.stop(); }
});

test('listen --help in tài liệu, không cần khoá', async () => {
  const r = await run(['listen', '--help'], { ...process.env, HOME: tmpdir(), USERPROFILE: tmpdir() });
  assert.equal(r.code, 0); assert.match(r.out, /NGHE kênh sự kiện/);
});

test('#872 nợ 5: trong lượt thức NGẦM của agentd (DBIO_AGENTD_TURN) listen/watch bị CHẶN (thoát 4) — không để listener mồ côi', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const sb = sandbox(srv.mcpUrl);
  try {
    for (const args of [['listen', '--as', 'T', '--max-min', '1'], ['staff', 'watch', '--as', 'T', '--max-min', '1']]) {
      const r = await run(args, { ...sb.env, DBIO_AGENTD_TURN: '1' });
      assert.equal(r.code, 4, `${args[0]}: ${r.err}`); assert.match(r.err, /NGẦM|headless/);
    }
    assert.equal(srv.conns.length, 0, 'không được mở kênh');
  } finally { await srv.stop(); }
});
