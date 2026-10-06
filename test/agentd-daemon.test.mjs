import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDaemon } from '../lib/agentd/daemon.mjs';
import { normalizeConfig } from '../lib/agentd/config.mjs';
import { keyFile } from '../lib/common.mjs';
import { runStream } from '../lib/stream/session.mjs';
import { endBeat, recordBeat } from '../lib/watch-state.mjs';
import { evt, hello, startFakeServer, waitFor } from './helpers/fake-stream-server.mjs';

const work = mkdtempSync(join(tmpdir(), 'daemon-'));
process.env.DBIO_STREAM_DIR = join(work, 'stream');
process.env.DBIO_AGENTD_STATUS = join(work, 'status.json');
process.env.DBIO_AGENTD_LOG_DIR = join(work, 'logs');
process.env.DBIO_NUDGED = join(work, 'nudged.json'); // không đụng sổ nhớ thật của thư ký
const KEY = 'sk_p2_abcdefghijklmnopqrstuvwxyz0123456789';
let n = 0;
const uniq = () => `T861_dmn_${process.pid}_${++n}`;

/** Lệnh thức giả: ghi {stdin, staff} vào tệp rồi thoát — chứng minh adapter command chạy thật. */
function wakeScript(name) {
  const script = join(work, `${name}.mjs`); const out = join(work, `${name}.out.json`);
  writeFileSync(script, `import fs from 'node:fs'; let s=''; process.stdin.on('data',c=>s+=c).on('end',()=>{ fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({t:Date.now(),stdin:s,staff:process.env.DBIO_WAKE_STAFF})+'\\n'); });`);
  return { script, out, runs: () => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}

function mk(srv, name, { defaults = {}, makeClient } = {}) {
  const w = wakeScript(name);
  const { config } = normalizeConfig({ staff: { [name]: { adapter: 'command', command: [process.execPath, w.script] } }, defaults: { coalesce_ms: 0, listener_confirm_s: 0.3, retry_s: 0.2, ...defaults } });
  const d = createDaemon({
    loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {}, makeClient,
    stream: (o) => runStream({ ...o, cfg: { key: KEY, mcp_url: srv.mcpUrl }, tickMs: 20 }),
  });
  return { d, w };
}

test('phiên NGHỈ (không có listen): assign ⇒ daemon gọi adapter < 5s, lời nhắc có tên + thẻ; tin đã ack', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const name = uniq(); const { d, w } = mk(srv, name);
  try {
    await d.start();
    await waitFor(() => srv.conns.length === 1);
    const t0 = Date.now(); srv.conns[0].send(evt(1, { text: 'Agent nhận việc kiểu đẩy' }));
    await waitFor(() => w.runs().length === 1, 5000);
    const r = w.runs()[0];
    assert.ok(r.t - t0 < 5000, `độ trễ ${r.t - t0}ms`);
    assert.equal(r.staff, name); assert.match(r.stdin, new RegExp(name)); assert.match(r.stdin, /1#1/); assert.match(r.stdin, /Agent nhận việc kiểu đẩy/);
    await waitFor(() => srv.conns[0].received.some((f) => f.op === 'ack' && f.ids.includes(1)));
    assert.equal(d.writeStatus().staff[name].wakes, 1);
    assert.ok(existsSync(process.env.DBIO_AGENTD_STATUS));
  } finally { d.stop(); await srv.stop(); }
});

test('phiên đang NGHE (listen sống): daemon nhường; nếu máy chủ báo tin đã đọc ⇒ không thức; chưa đọc ⇒ thức sau hạn xác nhận', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const name = uniq();
  let unread = false; const asked = [];
  const makeClient = () => ({ ai: async (tool, a) => { asked.push([tool, a.ids]); return { items: unread ? [{ id: 2, kind: 'assign', text: 'x', at: new Date().toISOString() }] : [] }; } });
  const { d, w } = mk(srv, name, { makeClient });
  const keyBeat = keyFile(name).replace(/\.json$/, '.alive.json');
  try {
    recordBeat(name, { mode: 'listen', every: 60_000 });
    await d.start(); await waitFor(() => srv.conns.length === 1);
    srv.conns[0].send(evt(1));
    await waitFor(() => asked.length >= 1, 3000);                       // sau ≥ 0.3s: kiểm tin chưa đọc
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(w.runs().length, 0, 'tin đã đọc (listen lo) ⇒ KHÔNG thức chồng');
    unread = true; srv.conns[0].send(evt(2));
    await waitFor(() => w.runs().length === 1, 4000);                    // listen "sống" mà tin vẫn chưa đọc ⇒ thức
  } finally { d.stop(); endBeat(name); try { unlinkSync(keyBeat); } catch { /* chưa có */ } await srv.stop(); }
});

test('adapter lỗi ⇒ KHÔNG ack, thử lại sau retry_s (không mất tin); lượt trước còn chạy ⇒ không chồng', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const name = uniq();
  const flag = join(work, `${name}.ready`);
  const script = join(work, `${name}.flaky.mjs`); const out = join(work, `${name}.flaky.out`);
  writeFileSync(script, `import fs from 'node:fs'; process.stdin.resume(); process.stdin.on('end',()=>{ fs.appendFileSync(${JSON.stringify(out)}, 'x'); setTimeout(()=>process.exit(0), 600); });`);
  const { config } = normalizeConfig({ staff: { [name]: { adapter: 'command', command: [process.execPath, script] } }, defaults: { coalesce_ms: 0, retry_s: 0.2 } });
  let fail = true;
  const d = createDaemon({
    loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {},
    getAdapter: (a) => ({ name: a, wake: async (ctx) => (fail ? { ok: false, detail: 'chưa sẵn sàng' } : (await import('../lib/agentd/adapters/index.mjs')).getAdapter('command').wake(ctx)) }),
    stream: (o) => runStream({ ...o, cfg: { key: KEY, mcp_url: srv.mcpUrl }, tickMs: 20 }),
  });
  try {
    await d.start(); await waitFor(() => srv.conns.length === 1);
    srv.conns[0].send(evt(1));
    await waitFor(() => d.st.get(name)?.failures >= 1, 3000);
    assert.ok(!srv.conns[0].received.some((f) => f.op === 'ack'), 'thất bại ⇒ chưa ack');
    fail = false; srv.conns[0].send(evt(2));
    await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').length >= 1, 4000);
    await waitFor(() => srv.conns[0].received.some((f) => f.op === 'ack' && f.ids.includes(1)), 4000);
    assert.equal(readFileSync(out, 'utf8').length >= 1, true);
    void flag;
  } finally { d.stop(); await srv.stop(); }
});

test('luật quét sổ cái: wake ⇒ thức phiên của máy này; im > 2h ⇒ bình luận kèm @PM; người ngoài máy KHÔNG bị thức', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const name = uniq(); const name2 = `${name}_b`; const other = `${name}_khac`;
  const comments = [];
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const old = fmt(Date.now() - 3 * 3_600_000); const fresh = fmt(Date.now() - 60_000);
  const board = { data: { columns: [{ id: 1, name: 'Đang làm' }, { id: 2, name: 'Đã giao' }], tasks: [
    { id: 11, title: 'thẻ im lâu', column_id: 1, updated_at: old, entered_column_at: old },
    { id: 12, title: 'thẻ ở máy khác', column_id: 2, updated_at: old, entered_column_at: old },
    { id: 13, title: 'thẻ mới giao', column_id: 2, updated_at: fresh, entered_column_at: fresh },
  ] } };
  const staff = [
    { name, runtime: { session_ref: 's1' }, task: { task_id: 11 }, last_seen_at: fresh },
    { name: name2, runtime: { session_ref: 's2' }, task: { task_id: 13 }, state: 'assigned_unacked' },
    { name: other, runtime: { session_ref: 's3' }, task: { task_id: 12 }, state: 'working' },
  ];
  const makeClient = () => ({ init: async () => 1, ai: async (tool) => (tool === 'staff_list' ? { staff } : {}), tb: async (a, args) => { if (a === 'get') return board; if (a === 'comment_add') { comments.push(args); return {}; } return { task: { comments: [], work_state: null } }; } });
  const w = wakeScript(name2); const w1 = wakeScript(name); const wo = wakeScript(other);
  const cmd = (x) => ({ adapter: 'command', command: [process.execPath, x.script] });
  const { config } = normalizeConfig({ staff: { [name]: cmd(w1), [name2]: cmd(w) }, rules: { sweep: { enabled: true, as: name, every_min: 0 } }, defaults: { coalesce_ms: 0 } });
  const d = createDaemon({ loadCfg: () => ({ config, errors: [] }), hasKey: () => false, log: () => {}, makeClient });
  try {
    await d.load();
    await d.sweep();
    await waitFor(() => w.runs().length === 1, 4000);
    assert.match(w.runs()[0].stdin, /#13/); assert.equal(w.runs()[0].staff, name2);
    assert.deepEqual(comments.map((c) => c.task_id).sort(), [11, 12]);
    for (const c of comments) assert.match(c.body, /@PM/);
    assert.equal(wo.runs().length, 0, 'nhân viên máy khác không bị thức từ máy này');
    await d.sweep(); // lần 2: đã ghi nhớ "đã báo" ⇒ không lặp
    assert.equal(comments.length, 2); assert.equal(w.runs().length, 1);
  } finally { d.stop(); await srv.stop(); }
});

test('cấu hình đổi ⇒ reconcile: thêm nhân viên mới mở kênh; gỡ ⇒ ngừng nghe', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const a = uniq(); const b = uniq();
  const w = wakeScript(a);
  let cur = normalizeConfig({ staff: { [a]: { adapter: 'command', command: [process.execPath, w.script] } } }).config;
  const d = createDaemon({ loadCfg: () => ({ config: cur, errors: [] }), hasKey: () => true, log: () => {}, stream: (o) => runStream({ ...o, cfg: { key: KEY, mcp_url: srv.mcpUrl }, tickMs: 20 }) });
  try {
    await d.start(); await waitFor(() => srv.conns.length === 1);
    cur = normalizeConfig({ staff: { [a]: { adapter: 'command', command: [process.execPath, w.script] }, [b]: { adapter: 'command', command: [process.execPath, w.script] } } }).config;
    await d.load(); await d.reconcile();
    await waitFor(() => d.streams.size === 2 && srv.conns.length === 2);
    cur = normalizeConfig({ staff: { [b]: { adapter: 'command', command: [process.execPath, w.script] } } }).config;
    await d.load(); await d.reconcile();
    assert.deepEqual([...d.streams.keys()], [b]);
  } finally { d.stop(); await srv.stop(); }
});

test('nhân viên chưa có khoá trên máy ⇒ bỏ qua, daemon vẫn chạy', async () => {
  const srv = await startFakeServer();
  const name = uniq(); const w = wakeScript(name);
  const { config } = normalizeConfig({ staff: { [name]: { adapter: 'command', command: [process.execPath, w.script] } } });
  const logs = [];
  const d = createDaemon({ loadCfg: () => ({ config, errors: [] }), hasKey: () => false, log: (m) => logs.push(m), stream: () => { throw new Error('không được mở'); } });
  try { const r = await d.start(); assert.deepEqual(r.staff, []); assert.ok(logs.some((l) => /chưa có khoá/.test(l))); } finally { d.stop(); await srv.stop(); }
});

test('adapter chạy hỏng NGAY (lệnh không có / thoát mã 1): tin KHÔNG bị ack, bị giữ lại', async () => {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const name = uniq();
  const { config } = normalizeConfig({ staff: { [name]: { adapter: 'command', command: ['khong-co-lenh-nay-861'] } }, defaults: { coalesce_ms: 0, retry_s: 5, spawn_grace_s: 3 } });
  const d = createDaemon({ loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {}, stream: (o) => runStream({ ...o, cfg: { key: KEY, mcp_url: srv.mcpUrl }, tickMs: 20 }) });
  try {
    await d.start(); await waitFor(() => srv.conns.length === 1);
    srv.conns[0].send(evt(1));
    await waitFor(() => d.st.get(name)?.failures >= 1, 6000);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!srv.conns[0].received.some((f) => f.op === 'ack'), 'thất bại sớm ⇒ chưa ack');
    assert.equal([...d.streams.values()][0].s.queue.length, 1);
  } finally { d.stop(); await srv.stop(); }
});
