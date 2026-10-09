/**
 * #965 ƯU TIÊN 1 (chủ chốt 9/10): phiên QUÁ NGƯỠNG tự dọn — cầu thư ký clear bằng lệnh cố định; phiên trống ⇒ cầu nạp vai.
 * Lượt thức ngầm (`claude -p`) KHÔNG có clear_session/set_remote_control của ứng dụng (đo 9/10) ⇒ lệnh dọn phải đi qua thư ký (send_message vào phiên ghim).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDaemon } from '../lib/agentd/daemon.mjs';
import { normalizeConfig } from '../lib/agentd/config.mjs';
import { buildCompactRelay, buildReloadRelay, compactOrder } from '../lib/agentd/rules.mjs';
import { keyFile } from '../lib/common.mjs';
import { runStream } from '../lib/stream/session.mjs';
import { endBeat, recordBeat } from '../lib/watch-state.mjs';
import { evt, hello, startFakeServer, waitFor } from './helpers/fake-stream-server.mjs';

const work = mkdtempSync(join(tmpdir(), 'compact-'));
process.env.DBIO_STREAM_DIR = join(work, 'stream');
process.env.DBIO_AGENTD_STATUS = join(work, 'status.json');
process.env.DBIO_AGENTD_LOG_DIR = join(work, 'logs');
process.env.DBIO_NUDGED = join(work, 'nudged.json');
const KEY = 'sk_p2_abcdefghijklmnopqrstuvwxyz0123456789';
let n = 0;
const uniq = () => `T965_cmp_${process.pid}_${++n}`;
const COLS = [{ id: 1, name: 'Đang làm' }];
const OVER = { blocked: true, tokens: 602_000, max: 250_000 };

/** Daemon với adapter giả `fake-desktop` (isBlank/activeAgoMs/overLimit tuỳ test) và client giả ghi lại mọi bình luận. */
function mk({ srv, adapter, defaults = {}, entry = {}, tasks = (who) => [{ id: 77, column_id: 1, labels: JSON.stringify([`@${who}`]) }] }) {
  const name = uniq(); const posted = []; const woken = []; const clock = { t: Date.now() };
  const { config } = normalizeConfig({ staff: { [name]: { adapter: 'fake-desktop', session: 'local_x', ...entry } }, defaults: { coalesce_ms: 0, relay_to: 'TK TEST', retry_s: 0, ...defaults } });
  const d = createDaemon({
    loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {}, now: () => clock.t,
    makeClient: () => ({
      init: async () => 1234, tb: async () => ({ data: { tasks: typeof tasks === 'function' ? tasks(name) : tasks, columns: COLS } }),
      ai: async (tool, a) => ({ items: (a.ids ?? []).map((id) => ({ id, kind: 'assign', text: 'x', at: new Date().toISOString() })) }),
      call: async (tool, a) => { posted.push(a); return {}; },
    }),
    getAdapter: () => ({ name: 'fake-desktop', ...adapter, wake: async (ctx) => { woken.push(ctx.prompt); return { ok: true, detail: 'ok' }; } }),
    stream: srv ? (o) => runStream({ ...o, cfg: { key: KEY, mcp_url: srv.mcpUrl }, tickMs: 20 }) : undefined,
  });
  return { d, name, posted, woken, clock, tick: (ms) => { clock.t += ms; } };
}

test('lệnh cố định: đủ checkpoint · dừng nền · tắt RC · clear self; tin chờ bị khử @ và liên kết', () => {
  const o = compactOrder('NV X');
  for (const re of [/checkpoint/, /tác vụ nền/, /set_remote_control \{session_id:"self", enabled:false\}/, /clear_session \{session_id:"self"\}/, /không hỏi lại/i]) assert.match(o, re);
  const m = buildCompactRelay({ name: 'NV X', session: 'local_x', to: 'TK', tokens: 602_000, max: 250_000, batch: [{ task: '1#2', kind: 'assign', text: '@PM <b>[x](y)</b> `rm`' }] });
  assert.match(m, /@TK/); assert.match(m, /602k/); assert.ok(!/@PM|<b>|`/.test(m.split('Tin đang chờ')[1]), 'tin chờ là dữ liệu: khử @, HTML, backtick');
  assert.match(buildReloadRelay({ name: 'NV X', session: 'local_x', to: 'TK', card: '1234#77' }), /takeover 77/);
});

test('phiên QUÁ NGƯỠNG có tin tới ⇒ KHÔNG thức ngầm, cầu thư ký clear; không cầu lặp trong hạn; không ack', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const { d, name, posted, woken } = mk({ srv, adapter: { isBlank: () => false, activeAgoMs: () => null, overLimit: () => OVER } });
  try {
    await d.start(); await waitFor(() => srv.conns.length === 1);
    srv.conns[0].send(evt(1, { task: '1234#9', text: '@MAC MKT làm thẻ' }));
    await waitFor(() => posted.length === 1, 8000);
    const p = posted[0];
    assert.deepEqual([p.action, p.profile_id, p.task_id, p.as], ['comment_add', 1234, 9, name]);
    for (const re of [/@TK TEST/, /CẦU DỌN PHIÊN/, /602k/, /250k/, /checkpoint/, /set_remote_control/, /clear_session/, /local_x/, /lần 1\/3/]) assert.match(p.body, re);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(posted.length, 1, 'không cầu lặp trong compact_retry_min'); assert.equal(woken.length, 0, 'lượt ngầm không có clear_session ⇒ không thức');
    assert.ok(!srv.conns[0].received.some((f) => f.op === 'ack'), 'chưa ack: tin ở lại tới khi phiên trống');
  } finally { d.stop(); await srv.stop(); }
});

test('cầu dọn không thành: thử lại cách compact_retry_min; hết compact_max_tries ⇒ báo @PM 1 lần / giờ', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const { d, posted, tick } = mk({ srv, defaults: { compact_retry_min: 15, compact_max_tries: 2 }, adapter: { isBlank: () => false, activeAgoMs: () => null, overLimit: () => OVER } });
  try {
    await d.start(); await waitFor(() => srv.conns.length === 1);
    srv.conns[0].send(evt(1, { task: '1234#9' }));
    await waitFor(() => posted.length === 1, 8000);
    tick(16 * 60_000); await waitFor(() => posted.length === 2, 8000); assert.match(posted[1].body, /lần 2\/2/);
    tick(16 * 60_000); await waitFor(() => posted.length === 3, 8000);
    assert.match(posted[2].body, /KẸT/); assert.match(posted[2].body, /@PM/); assert.match(posted[2].body, /đã cầu dọn 2 lần/);
    tick(16 * 60_000); await new Promise((r) => setTimeout(r, 400)); assert.equal(posted.length, 3, 'báo 1 lần / giờ');
  } finally { d.stop(); await srv.stop(); }
});

test('sau khi phiên được dọn (TRỐNG) ⇒ sổ dọn reset, chuyển sang cầu NẠP VAI (đường phiên trống)', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  let blank = false;
  const { d, posted, tick } = mk({ srv, adapter: { isBlank: () => blank, activeAgoMs: () => null, overLimit: () => (blank ? { blocked: false } : OVER) } });
  try {
    await d.start(); await waitFor(() => srv.conns.length === 1);
    srv.conns[0].send(evt(1, { task: '1234#9' }));
    await waitFor(() => posted.length === 1 && /CẦU DỌN PHIÊN/.test(posted[0].body), 8000);
    blank = true; tick(6_000); // phiên đã tự clear
    await waitFor(() => posted.length === 2, 10_000);
    assert.match(posted[1].body, /CẦU KHẨN/); assert.match(posted[1].body, /next --take/);
  } finally { d.stop(); await srv.stop(); }
});

test('auto_compact:false ⇒ giữ cách cũ (rơi xuống adapter, không cầu dọn)', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const { d, posted, woken } = mk({ srv, entry: { auto_compact: false }, adapter: { isBlank: () => false, activeAgoMs: () => null, overLimit: () => OVER } });
  try {
    await d.start(); await waitFor(() => srv.conns.length === 1);
    srv.conns[0].send(evt(1, { task: '1234#9' }));
    await waitFor(() => woken.length >= 1, 8000);
    assert.equal(posted.filter((p) => /CẦU DỌN/.test(p.body ?? '')).length, 0);
  } finally { d.stop(); await srv.stop(); }
});

test('dọn CHỦ ĐỘNG: phiên rảnh quá ngưỡng đang cầm thẻ ⇒ cầu dọn trên thẻ đó; không cầm thẻ ⇒ để yên', async () => {
  const a = mk({ adapter: { isBlank: () => false, activeAgoMs: () => 30 * 60_000, overLimit: () => OVER } });
  await a.d.load(); await a.d.hygiene();
  assert.equal(a.posted.length, 1); assert.deepEqual([a.posted[0].profile_id, a.posted[0].task_id], [1234, 77]); assert.match(a.posted[0].body, /CẦU DỌN PHIÊN/);
  const b = mk({ tasks: [], adapter: { isBlank: () => false, activeAgoMs: () => 30 * 60_000, overLimit: () => OVER } });
  await b.d.load(); await b.d.hygiene(); assert.equal(b.posted.length, 0, 'không cầm thẻ ⇒ không đánh thức vô ích');
});

test('dọn chủ động: phiên đang HOẠT ĐỘNG hoặc listen sống ⇒ không đụng; hết hoạt động ⇒ dọn', async () => {
  let act = 5 * 60_000;
  const { d, name, posted } = mk({ adapter: { isBlank: () => false, activeAgoMs: () => act, overLimit: () => OVER } });
  const keyBeat = keyFile(name).replace(/\.json$/, '.alive.json');
  try {
    await d.load(); await d.hygiene(); assert.equal(posted.length, 0, 'mới hoạt động 5 phút trước');
    act = 40 * 60_000; recordBeat(name, { mode: 'listen', every: 60_000 }); await d.hygiene(); assert.equal(posted.length, 0, 'listen đang sống');
    endBeat(name); await d.hygiene(); assert.equal(posted.length, 1);
  } finally { try { unlinkSync(keyBeat); } catch { /* chưa có */ } }
});

test('phiên TRỐNG mà còn cầm thẻ ⇒ cầu NẠP VAI (1 lần / giờ / thẻ); hết thẻ ⇒ để trống', async () => {
  let held = true;
  const { d, name, posted, tick } = mk({ tasks: (who) => (held ? [{ id: 77, column_id: 1, labels: JSON.stringify([`@${who}`]) }] : []), adapter: { isBlank: () => true, activeAgoMs: () => null, overLimit: () => ({ blocked: false }) } });
  await d.load();
  await d.hygiene(); assert.equal(posted.length, 1); assert.match(posted[0].body, /CẦU NẠP VAI/); assert.match(posted[0].body, /takeover 77/); assert.match(posted[0].body, new RegExp(name));
  await d.hygiene(); assert.equal(posted.length, 1, 'chưa tới 1 giờ');
  tick(61 * 60_000); await d.hygiene(); assert.equal(posted.length, 3, 'dự phòng PM + cầu lại');
  held = false; tick(61 * 60_000); await d.hygiene(); assert.equal(posted.length, 3, 'không còn thẻ ⇒ để trống');
});

test('hygiene tắt (rules.hygiene.enabled:false) hoặc nhân viên là thư ký ⇒ không làm gì', async () => {
  const off = mk({ adapter: { isBlank: () => false, activeAgoMs: () => 99 * 60_000, overLimit: () => OVER } });
  await off.d.load(); off.d.config.rules.hygiene.enabled = false; await off.d.hygiene(); assert.equal(off.posted.length, 0);
  const sec = mk({ entry: { secretary: true }, adapter: { isBlank: () => false, activeAgoMs: () => 99 * 60_000, overLimit: () => OVER } });
  await sec.d.load(); await sec.d.hygiene(); assert.equal(sec.posted.length, 0);
});

test('adapter claude-desktop.overLimit đọc tệp phiên + hội thoại thật: lớn ⇒ blocked, nhỏ/trống/allow_large ⇒ không', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { default: desk } = await import('../lib/agentd/adapters/claude-desktop.mjs');
  const sess = join(work, 'sessions'); const proj = join(work, 'projects'); mkdirSync(join(sess, 'a', 'b'), { recursive: true }); mkdirSync(join(proj, 'd'), { recursive: true });
  const line = (n) => `${JSON.stringify({ message: { usage: { input_tokens: 1, cache_read_input_tokens: n, cache_creation_input_tokens: 0 } } })}\n`;
  writeFileSync(join(proj, 'd', 'cli-big.jsonl'), line(602_000)); writeFileSync(join(proj, 'd', 'cli-small.jsonl'), line(50_000));
  writeFileSync(join(sess, 'a', 'b', 'local_big.json'), JSON.stringify({ cliSessionId: 'cli-big', cwd: work }));
  writeFileSync(join(sess, 'a', 'b', 'local_small.json'), JSON.stringify({ cliSessionId: 'cli-small', cwd: work }));
  writeFileSync(join(sess, 'a', 'b', 'local_blank.json'), JSON.stringify({ cwd: work }));
  const e = (session, x = {}) => ({ session, sessions_dir: sess, projects_dir: proj, max_context_tokens: 250_000, ...x });
  const big = desk.overLimit(e('local_big')); assert.equal(big.blocked, true); assert.equal(big.tokens, 602_001); assert.equal(big.max, 250_000);
  assert.equal(desk.overLimit(e('local_small')).blocked, false);
  assert.equal(desk.overLimit(e('local_blank')).blocked, false, 'phiên trống ⇒ không dọn');
  assert.equal(desk.overLimit(e('local_big', { allow_large: true })).blocked, false);
  assert.equal(desk.overLimit(e('local_missing')).blocked, false);
});

/* ---------- #965 (PM 09:15/09:26): hết CẦU LẶP vô ích cho phiên trống không cầm thẻ ---------- */
test('phiên TRỐNG không cầm thẻ liên quan: tin @nhắc cũ ⇒ ACK, KHÔNG cầu; tin giao việc (assign) vẫn cầu', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const { d, posted } = mk({ srv, tasks: [], adapter: { isBlank: () => true, activeAgoMs: () => null, overLimit: () => ({ blocked: false }) } });
  try {
    await d.start(); await waitFor(() => srv.conns.length === 1);
    srv.conns[0].send(evt(1, { task: '1234#9', kind: 'mention', text: 'nhắc cũ đã xử lý' }));
    await waitFor(() => srv.conns[0].received.some((f) => f.op === 'ack' && f.ids.includes(1)), 8000);
    assert.equal(posted.length, 0, 'không cầm thẻ ⇒ không đánh thức PM/thư ký');
    srv.conns[0].send(evt(2, { task: '1234#10', kind: 'assign', text: 'việc mới' }));
    await waitFor(() => posted.length === 1, 8000); assert.match(posted[0].body, /CẦU KHẨN/);
  } finally { d.stop(); await srv.stop(); }
});

test('phiên TRỐNG đang cầm thẻ #77: tin trên thẻ đó ⇒ cầu; cầu cùng (nhân viên, thẻ) tối đa 1 lần / relay_card_min', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const { d, posted, tick } = mk({ srv, defaults: { redeliver_after_min: 1 }, adapter: { isBlank: () => true, activeAgoMs: () => null, overLimit: () => ({ blocked: false }) } });
  try {
    await d.start(); await waitFor(() => srv.conns.length === 1);
    srv.conns[0].send(evt(1, { task: '1234#77', kind: 'mention', text: 'thẻ đang cầm' }));
    await waitFor(() => posted.length === 1, 8000);
    tick(30 * 60_000); await new Promise((r) => setTimeout(r, 500)); assert.equal(posted.length, 1, 'chưa đủ 60 phút ⇒ không cầu lại');
  } finally { d.stop(); await srv.stop(); }
});

test('(v0.3.2) cầu NẠP VAI mà phiên vẫn trống sau 5\' ⇒ dự phòng báo PM đúng 1 lần', async () => {
  const { d, posted, tick } = mk({ tasks: (who) => [{ id: 77, column_id: 1, labels: JSON.stringify([`@${who}`]) }], adapter: { isBlank: () => true, activeAgoMs: () => null, overLimit: () => ({ blocked: false }) } });
  await d.load();
  await d.hygiene(); assert.equal(posted.length, 1);
  tick(3 * 60_000); await d.hygiene(); assert.equal(posted.length, 1, 'chưa tới 5 phút');
  tick(3 * 60_000); await d.hygiene(); assert.equal(posted.length, 2); assert.match(posted[1].body, /DỰ PHÒNG/); assert.match(posted[1].body, /takeover 77/);
  tick(3 * 60_000); await d.hygiene(); assert.equal(posted.length, 2, 'chỉ báo 1 lần');
});
