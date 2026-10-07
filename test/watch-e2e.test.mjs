/**
 * Chạy THẬT `dbio staff watch` với máy chủ MCP giả (HTTP cục bộ) + thư mục HOME tạm ⇒ kiểm toàn bộ vòng lặp: --fresh, bản sao, direct_count,
 * 60 chưa đọc + 1 tin mới (REGRESSION regression-1), nhịp alive.json.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/dbio-staff.mjs', import.meta.url));
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

/** state.events: [{id, kind, task, text, at, state?, copy_of?, from_character_id?, read}]; mode 'new' | 'old'. */
function fakeMcp(state) {
  const calls = [];
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const { params } = JSON.parse(b); const a = params.arguments;
      calls.push(a);
      let out = {};
      const unread = state.events.filter((e) => !e.read);
      if (a.action === 'staff_pulse') {
        const direct = unread.filter((e) => !(e.state === 'copy'));
        const copies = unread.filter((e) => e.state === 'copy');
        out = state.mode === 'new'
          ? { who: { id: 1, name: a.who }, unread: { count: unread.length, direct_count: direct.length, copy_count: copies.length, ids: unread.slice(-20).map((e) => e.id), copy_ids: copies.slice(-20).map((e) => e.id), latest_at: null }, discuss_ai: { count: 0, refs: [] } }
          : { who: { id: 1, name: a.who }, unread: { count: unread.length, ids: unread.slice(0, 50).map((e) => e.id) }, discuss_ai: { count: 0, refs: [] } };
      } else if (a.action === 'staff_inbox') {
        let rows = unread;
        if (state.mode === 'new' && Array.isArray(a.ids)) rows = state.events.filter((e) => a.ids.includes(e.id));
        out = { who: { id: 1 }, items: rows.slice(0, a.limit ?? 30) };
      } else if (a.action === 'staff_inbox_ack') {
        for (const e of state.events) if (a.ids.includes(e.id)) e.read = true;
        out = { success: true };
      } else if (a.action === 'staff_list') out = { staff: state.staff ?? [] };
      else if (a.action === 'get' && state.board) out = { data: state.board };
      else if (params.name === 'task_board') out = { task: { column: { name: 'Nhận' } } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ success: true, ...out }) }] } }));
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, calls, url: `http://127.0.0.1:${srv.address().port}/mcp` })));
}

async function runWatch(state, who, extra = []) {
  const f = await fakeMcp(state);
  const home = mkdtempSync(join(tmpdir(), 'dbio-e2e-'));
  mkdirSync(join(home, '.dbio', 'staff-keys'), { recursive: true });
  writeFileSync(join(home, '.dbio', 'staff-keys', `${who.replace(/[^\p{L}\p{N}_-]/gu, '_')}.json`), JSON.stringify({ who, store_id: 1, mcp_url: f.url, key: 'sk_test' }));
  writeFileSync(join(home, '.dbio', 'watch.json'), JSON.stringify({ secretaries: ['THƯ KÝ'] }));
  const env = { ...process.env, DBIO_AGENTD_TURN: '', USERPROFILE: home, HOME: home, DBIO_WATCH_LOG: join(home, 'watch-log.jsonl'), DBIO_BOARD: '1001' };
  const child = spawn(process.execPath, [BIN, 'staff', '--as', who, 'watch', '--max-min', '0.03', '--slow', '1', '--fast', '1', '--coalesce', '0', ...extra], { env });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((ok) => child.on('close', ok));
  f.srv.close();
  return { code, out, err, home, calls: f.calls };
}

const ev = (id, o = {}) => ({ id, kind: 'mention', task: '1001#700', from_character_id: 9, text: `ghi chú ${id}`, at: ago(3600), read: false, ...o });

test('e2e REGRESSION (regression-1): máy chủ MỚI, KHÔNG --fresh: 60 cũ chưa đọc + 1 mới ⇒ thức bằng tin mới (cửa sổ 20 mới nhất)', async () => {
  const events = Array.from({ length: 60 }, (_, i) => ev(i + 1, { text: 'ghi chú thường' }));
  events.push(ev(61, { text: 'Anh GO không?', at: ago(0) }));
  const state = { mode: 'new', events };
  // 20 tin mới nhất = 42..61; 42..60 là ghi chú thường (gom), 61 khẩn ⇒ thức
  const r = await runWatch(state, 'E2E NEW2');
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /1 khẩn/); assert.match(r.out, /GO không/);
});

test('e2e: chỉ có BẢN SAO ⇒ không thức, tự ack, báo số bản sao (PM/lead)', async () => {
  const events = [ev(1, { state: 'copy', copy_of: 1301, text: 'A hỏi B: xong chưa?', at: ago(0) }), ev(2, { state: 'copy', copy_of: 1301, text: 'GO?', at: ago(0) })];
  const state = { mode: 'new', events };
  const r = await runWatch(state, 'E2E LEAD');
  assert.equal(r.code, 3, `${r.out}\n${r.err}`);
  assert.match(r.out, /2 bản sao đã ack/);
  assert.ok(state.events.every((e) => e.read));
});

test('e2e: THƯ KÝ nhận bản sao tin nhắc ⇒ KHẨN, thức NGAY (#745 theo sự kiện, không chờ đủ lô)', async () => {
  const events = Array.from({ length: 5 }, (_, i) => ev(i + 1, { state: 'copy', copy_of: 1301, text: `A hỏi B ${i}?`, at: ago(0) }));
  const r = await runWatch({ mode: 'new', events }, 'THƯ KÝ');
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /5 khẩn · 0 thường/);
});

test('e2e #745: THƯ KÝ quét sổ cái bằng script — thẻ Đã giao chưa ACK ⇒ thức kèm dòng ĐÁNH THỨC + id phiên; lần sau (đã nhắc) không thức lại', async () => {
  const at = (m) => new Date(Date.now() - m * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const board = { columns: [{ id: 14, name: 'Đã giao' }, { id: 12, name: 'Đang làm' }], tasks: [{ id: 9, column_id: 14, title: 'thẻ TEST', labels: ['@DEV X'], updated_at: at(1), entered_column_at: at(1) }] };
  const staff = [{ id: 5, name: 'DEV X', state: 'assigned_unacked', last_seen_at: at(1), runtime: { session_ref: 'local_devx' } }];
  const home0 = mkdtempSync(join(tmpdir(), 'dbio-nudged-'));
  process.env.DBIO_NUDGED = join(home0, 'nudged.json');
  const r = await runWatch({ mode: 'new', events: [], board, staff }, 'THƯ KÝ');
  assert.equal(r.code, 0, `${r.out}
${r.err}`);
  assert.match(r.out, /1 việc quét sổ cái/); assert.match(r.out, /ĐÁNH THỨC #9 · DEV X → local_devx/);
  const r2 = await runWatch({ mode: 'new', events: [], board, staff }, 'THƯ KÝ');
  assert.equal(r2.code, 3, `${r2.out}
${r2.err}`); // đã nhắc ≤10' ⇒ không thức lại
  delete process.env.DBIO_NUDGED;
});

test('e2e --fresh: tin chưa đọc tạo trước lúc chạy bị ack, không báo; tin cũ khẩn không đánh thức', async () => {
  const events = [ev(1, { text: 'GO?', kind: 'request' }), ev(2, { text: 'cũ khác', kind: 'owner_reply' })];
  const state = { mode: 'old', events };
  const r = await runWatch(state, 'E2E FRESH', ['--fresh']);
  assert.equal(r.code, 3, `${r.out}\n${r.err}`);
  assert.match(r.err, /ack 2 tin cũ/);
  assert.ok(state.events.every((e) => e.read));
});

test('e2e: máy chủ CŨ (không direct/copy) vẫn chạy như trước — tin khẩn trong cửa sổ ⇒ thức; ghi alive.json', async () => {
  const events = [ev(1, { kind: 'request', text: 'xin GO' })];
  const r = await runWatch({ mode: 'old', events }, 'E2E OLD');
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.out, /1 khẩn/);
  const beat = JSON.parse(readFileSync(join(r.home, '.dbio', 'staff-keys', 'E2E_OLD.alive.json'), 'utf8'));
  assert.equal(beat.ended, true); assert.ok(beat.beat > 0);
});
