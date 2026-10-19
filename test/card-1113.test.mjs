import './helpers/hermetic.mjs';
// #1113 — chặn lỗi quy trình bằng MÃ: claim ⇒ Đang làm · done chặn mã chưa push · dừng chain báo PM. Cách ly: không claude thật, không mạng (git cục bộ).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keyFile } from '../lib/common.mjs';
import { createDaemon } from '../lib/agentd/daemon.mjs';
import { normalizeConfig } from '../lib/agentd/config.mjs';
import { moveToDoing } from '../lib/agentd/claim-move.mjs';
import { describeUnpushed, shasIn, unpushedReport } from '../lib/push-guard.mjs';
import { runStream } from '../lib/stream/session.mjs';
import { evt, hello, startFakeServer, waitFor } from './helpers/fake-stream-server.mjs';

const work = mkdtempSync(join(tmpdir(), 'card1113-'));
process.env.DBIO_STREAM_DIR = join(work, 'stream');
process.env.DBIO_AGENTD_STATUS = join(work, 'status.json');
process.env.DBIO_AGENTD_LOG_DIR = join(work, 'logs');
process.env.DBIO_AGENTD_RUNS_DIR = join(work, 'runs');
process.env.DBIO_AGENTD_LEASE_DIR = join(work, 'lease');
const KEY = 'sk_p2_abcdefghijklmnopqrstuvwxyz0123456789';
let n = 0; const uniq = () => `T1113_${process.pid}_${++n}`;

const board = (colName) => ({ data: { columns: [{ id: 1, name: 'Đã giao' }, { id: 2, name: 'Đang làm' }], tasks: [{ id: 9, column_id: colName === 'Đã giao' ? 1 : 2 }] } });

test('moveToDoing: Đã giao ⇒ task_move Đang làm; đã Đang làm ⇒ bỏ qua; lỗi ⇒ không ném', async () => {
  const calls = [];
  const mk = (col, fail) => ({ tb: async (a, args) => { calls.push([a, args]); if (a === 'get') return board(col); if (fail) throw new Error('boom'); return {}; } });
  assert.equal(await moveToDoing(mk('Đã giao'), '162801#9'), 'moved');
  assert.deepEqual(calls.at(-1), ['task_move', { task_id: 9, column_name: 'Đang làm' }]);
  calls.length = 0; assert.equal(await moveToDoing(mk('Đang làm'), '162801#9'), 'skip'); assert.equal(calls.length, 1);
  assert.equal(await moveToDoing(mk('Đã giao', true), '162801#9'), 'error');
  assert.equal(await moveToDoing({ tb: async () => { throw new Error('mạng'); } }, '162801#9'), 'error');
});

test('claim Run thành công cho thẻ ở Đã giao ⇒ daemon chuyển Đang làm TRƯỚC khi spawn; lỗi chuyển không chặn lượt', async () => {
  for (const failMove of [false, true]) {
    const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
    const name = uniq(); const order = []; const woken = [];
    const { config } = normalizeConfig({ staff: { [name]: { adapter: 'claude-desktop', runtime: 'claude_desktop', session: 'local_x' } }, defaults: { coalesce_ms: 0, retry_s: 0.05 } });
    const d = createDaemon({
      loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {},
      makeClient: () => ({
        init: async () => 162801,
        tb: async (a) => { if (a === 'get') return board('Đã giao'); if (a === 'task_move') { order.push('move'); if (failMove) throw new Error('boom'); return {}; } return a === 'task_get' ? { task: { id: 9, title: 't', comments: [] } } : {}; },
        ai: async (tool, a) => ({ items: (a.ids ?? []).map((id) => ({ id, kind: 'assign', text: 'x', task: '162801#9', at: new Date().toISOString() })) }),
        call: async (tool, a) => { if (a.action === 'run_record') order.push('claim'); return {}; },
      }),
      getAdapter: () => ({ name: 'claude-desktop', spawns: false, claims: true, isBlank: () => false, activeAgoMs: () => null, wake: async (ctx) => { order.push('wake'); woken.push(ctx); return { ok: true, detail: 'ok' }; } }),
      stream: (o) => runStream({ ...o, cfg: { key: KEY, mcp_url: srv.mcpUrl }, tickMs: 20 }),
    });
    try {
      await d.start(); await waitFor(() => srv.conns.length === 1); srv.conns[0].send(evt(1, { task: '162801#9' }));
      await waitFor(() => woken.length >= 1, 8000);
      assert.ok(order.indexOf('claim') >= 0 && order.indexOf('claim') < order.indexOf('move') && order.indexOf('move') < order.indexOf('wake'), `thứ tự ${order.join('>')}`);
    } finally { d.stop(); await srv.stop(); }
  }
});

test('dừng chain (lượt chỉ-kiểm lặp) ⇒ bình luận @PM + patrol.check_stopped trong status; 1 lần / thẻ', async () => {
  const comments = [];
  const name = uniq();
  const { config } = normalizeConfig({ staff: { [name]: { adapter: 'claude-desktop', runtime: 'claude_desktop', session: 'local_x' } }, defaults: { chain_check_max: 1, relay_to: 'PM giao việc' } });
  const d = createDaemon({
    loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {},
    makeClient: () => ({ init: async () => 162801, tb: async () => ({}), ai: async () => ({}), call: async (t, a) => { if (a.action === 'comment_add') comments.push(a); return {}; } }),
  });
  await d.load();
  await d.chainNext(name, {}, '162801#9', true);
  await d.chainNext(name, {}, '162801#9', true);
  await waitFor(() => comments.length >= 1, 3000); await new Promise((r) => setTimeout(r, 100));
  assert.equal(comments.length, 1, 'báo 1 lần');
  assert.match(comments[0].body, /@PM/); assert.equal(comments[0].task_id, 9);
  assert.deepEqual(d.writeStatus().patrol.check_stopped, ['162801#9']);
});

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo() {
  const root = mkdtempSync(join(work, 'g-')); const bare = join(root, 'remote.git'); const wc = join(root, 'wc');
  mkdirSync(bare); sh(bare, 'init', '--bare'); sh(root, 'clone', bare, wc);
  sh(wc, 'config', 'user.email', 't@t'); sh(wc, 'config', 'user.name', 't'); sh(wc, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(wc, 'a.txt'), '1'); sh(wc, 'add', '.'); sh(wc, 'commit', '-m', 'one'); sh(wc, 'push', '-u', 'origin', 'HEAD:main');
  sh(wc, 'branch', '-u', 'origin/main');
  return wc;
}

test('unpushedReport: sạch ⇒ không; commit trước upstream ⇒ ahead; sha trong chữ chưa push ⇒ shas; sha đã push / lạ ⇒ bỏ qua', () => {
  const wc = repo();
  const pushed = sh(wc, 'rev-parse', 'HEAD');
  assert.equal(unpushedReport(wc, [pushed]).any, false);
  writeFileSync(join(wc, 'a.txt'), '2'); sh(wc, 'commit', '-am', 'two');
  const local = sh(wc, 'rev-parse', '--short', 'HEAD');
  const r = unpushedReport(wc, [`xong ở ${local}`, 'sha lạ deadbee1234']);
  assert.equal(r.ahead.length, 1); assert.deepEqual(r.shas, [local]); assert.match(describeUnpushed(r), /chưa lên upstream.*sha chưa nằm/);
  assert.equal(unpushedReport(wc, [pushed.slice(0, 9)]).shas.length, 0);
  sh(wc, 'push', 'origin', 'HEAD:main'); assert.equal(unpushedReport(wc, [local]).any, false);
  assert.equal(unpushedReport(null).any, false);
});

test('shasIn: bỏ số thuần / từ thường; lấy hex ≥7 có cả chữ và số', () => {
  assert.deepEqual(shasIn('thẻ 1234567 và deadbe3f, abcdefa, e871352'), ['deadbe3f', 'e871352']);
});

test('staff done: commit chưa push ⇒ TỪ CHỐI "push trước", lý do quá ngắn vẫn chặn; checkpoint chỉ cảnh báo (--dry, không mạng)', () => {
  const kf = keyFile('NV1'); mkdirSync(join(kf, '..'), { recursive: true }); writeFileSync(kf, JSON.stringify({ key: 'sk_p2_x', mcp_url: 'http://127.0.0.1:9/mcp', board: 162801 })); // khoá giả, cổng đóng ⇒ không mạng thật
  const wc = repo(); writeFileSync(join(wc, 'a.txt'), '2'); sh(wc, 'commit', '-am', 'two'); sh(wc, 'push', 'origin', 'HEAD:feat'); // HEAD đã ở nhánh remote khác nhưng upstream (main) chưa có ⇒ chỉ chốt mới mới bắt
  const bin = join(process.cwd(), 'bin', 'dbio-staff.mjs');
  const run = (...a) => { try { return { code: 0, out: execFileSync(process.execPath, [bin, 'staff', '--as', 'NV1', ...a], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };
  const d = run('done', '162801#9', '--state', 's', '--proof', 'p', '--debt', 'd', '--next', 'n', '--dir', wc);
  assert.notEqual(d.code, 0); assert.match(d.out, /push trước/);
  const d2 = run('done', '162801#9', '--state', 's', '--proof', 'p', '--debt', 'd', '--next', 'n', '--dir', wc, '--allow-unpushed', 'x');
  assert.match(d2.out, /push trước/);
  const c = run('checkpoint', '162801#9', '--next', 'n', '--dir', wc, '--dry');
  assert.match(c.out, /CHƯA PUSH/);
});
