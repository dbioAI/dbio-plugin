import './helpers/hermetic.mjs';
// #1113 mở rộng (5–7) — Chờ duyệt quá hạn · done chặn mã chưa deploy · đo ngữ cảnh không cộng transcript trước dọn. Cách ly: không claude thật, không mạng.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keyFile } from '../lib/common.mjs';
import { createDaemon } from '../lib/agentd/daemon.mjs';
import { normalizeConfig } from '../lib/agentd/config.mjs';
import { reviewOverdue } from '../lib/agentd/patrol.mjs';
import { contextTokensFromTail } from '../lib/agentd/context-size.mjs';
import { changedDeployables, claimsDeployed, deployableFiles } from '../lib/deploy-guard.mjs';

const work = mkdtempSync(join(tmpdir(), 'card1113b-'));
process.env.DBIO_STREAM_DIR = join(work, 'stream');
process.env.DBIO_AGENTD_STATUS = join(work, 'status.json');
process.env.DBIO_AGENTD_LOG_DIR = join(work, 'logs');
process.env.DBIO_AGENTD_RUNS_DIR = join(work, 'runs');
process.env.DBIO_AGENTD_LEASE_DIR = join(work, 'lease');

const T0 = Date.parse('2026-10-20T10:00:00Z');
const cols = [{ id: 1, name: 'Đang làm' }, { id: 3, name: 'Chờ duyệt' }];
const rv = (id, minsAgo, over = {}) => ({ id, column_id: 3, entered_column_at: new Date(T0 - minsAgo * 60_000).toISOString(), ...over });

test('reviewOverdue: <30 phút im · 30 phút–2h nudge · ≥2h overdue; thẻ chờ chủ / cột khác bỏ', () => {
  const r = reviewOverdue({ board: 5, columns: cols, now: T0, tasks: [rv(1, 10), rv(2, 31), rv(3, 121), rv(4, 500, { work_state: { blocked: 'owner' } }), rv(5, 500, { blocked_reason: 'chờ chủ' }), { id: 6, column_id: 1, entered_column_at: new Date(T0 - 9e6).toISOString() }, rv(7, 60, { entered_column_at: undefined, updated_at: undefined })] });
  assert.deepEqual(r.map((x) => [x.card, x.stage]), [['5#2', 'nudge'], ['5#3', 'overdue']]);
  assert.deepEqual(reviewOverdue({ board: 5, columns: [{ id: 1, name: 'Đang làm' }], tasks: [rv(1, 999)], now: T0 }), []);
});

test('daemon.patrol: Chờ duyệt quá hạn ⇒ nhắc @PM 1 lần ở 30 phút, quá 2h ⇒ review_overdue + bình luận; hết hạn khi thẻ rời cột', async () => {
  let clock = T0; const comments = []; let tasks = [rv(8, 31)];
  const { config } = normalizeConfig({ staff: { PT1: { adapter: 'fake-spawn' } }, defaults: { coalesce_ms: 0 } });
  const d = createDaemon({
    loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {}, now: () => clock,
    makeClient: () => ({ init: async () => '77', tb: async () => ({ data: { tasks, columns: cols } }), ai: async () => ({ items: [] }), call: async (t, a) => { if (a.action === 'comment_add') comments.push(a); return {}; } }),
    getAdapter: () => ({ name: 'fake-spawn', spawns: true, isBlank: () => false, activeAgoMs: () => null, wake: async () => ({ ok: true, detail: 'ok' }) }),
    stream: () => ({ state: { connected: true, channel: 'open' }, queue: [], done: new Promise(() => {}), stop() {} }),
  });
  await d.start();
  try {
    await d.patrol(); await d.patrol();
    assert.equal(comments.length, 1); assert.match(comments[0].body, /@PM/); assert.equal(comments[0].task_id, 8);
    assert.deepEqual(d.writeStatus().patrol.review_overdue, []);
    tasks = [rv(8, 125)]; clock += 6 * 60_000; await d.patrol(); await d.patrol();
    assert.equal(comments.length, 2); assert.match(comments[1].body, /quá 120/);
    assert.deepEqual(d.writeStatus().patrol.review_overdue, ['77#8']);
    tasks = []; clock += 6 * 60_000; await d.patrol();
    assert.deepEqual(d.writeStatus().patrol.review_overdue, []);
  } finally { d.stop(); }
});

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(file) {
  const root = mkdtempSync(join(work, 'g-')); const bare = join(root, 'remote.git'); const wc = join(root, 'wc');
  mkdirSync(bare); sh(bare, 'init', '--bare'); sh(root, 'clone', bare, wc);
  sh(wc, 'config', 'user.email', 't@t'); sh(wc, 'config', 'user.name', 't'); sh(wc, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(wc, 'a.txt'), '1'); sh(wc, 'add', '.'); sh(wc, 'commit', '-m', 'one'); sh(wc, 'push', '-u', 'origin', 'HEAD:main'); sh(wc, 'branch', '-u', 'origin/main');
  mkdirSync(join(wc, file, '..'), { recursive: true }); writeFileSync(join(wc, file), 'x'); sh(wc, 'add', '.'); sh(wc, 'commit', '-m', 'two'); sh(wc, 'push', 'origin', 'HEAD:main');
  return wc;
}

test('deploy-guard: deployableFiles / claimsDeployed / changedDeployables', () => {
  assert.deepEqual(deployableFiles(['client-frontend/src/a.ts', 'docs/x.md', 'backend/src/r.ts', 'dbio-plugin/lib/x.mjs']), ['client-frontend/src/a.ts', 'backend/src/r.ts']);
  assert.equal(claimsDeployed('đã deploy p2'), true); assert.equal(claimsDeployed('client 0.0.3801 live'), true); assert.equal(claimsDeployed('đã commit và push'), false);
  const wc = repo('client-frontend/src/a.ts'); assert.deepEqual(changedDeployables(wc, []).deployable, ['client-frontend/src/a.ts']);
  assert.deepEqual(changedDeployables(repo('docs/a.md'), []).deployable, []);
});

test('staff done: mã client-frontend chưa nêu bản chạy thật ⇒ TỪ CHỐI; --not-deployed ngắn vẫn chặn; có bằng chứng deploy hoặc lý do đủ ⇒ qua cổng này', () => {
  const kf = keyFile('NV1'); mkdirSync(join(kf, '..'), { recursive: true }); writeFileSync(kf, JSON.stringify({ key: 'sk_p2_x', mcp_url: 'http://127.0.0.1:9/mcp', board: 162801 }));
  const bin = join(process.cwd(), 'bin', 'dbio-staff.mjs');
  const run = (wc, proof, ...extra) => { try { return { code: 0, out: execFileSync(process.execPath, [bin, 'staff', '--as', 'NV1', 'done', '162801#9', '--state', 's', '--proof', proof, '--debt', 'd', '--next', 'n', '--dir', wc, ...extra], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };
  const wc = repo('client-frontend/src/a.ts');
  const a = run(wc, 'p'); assert.notEqual(a.code, 0); assert.match(a.out, /phải DEPLOY/);
  assert.match(run(wc, 'p', '--not-deployed', 'x').out, /phải DEPLOY/);
  assert.doesNotMatch(run(wc, 'client 0.0.3801 đã deploy p2').out, /phải DEPLOY/);
  assert.doesNotMatch(run(wc, 'p', '--not-deployed', 'chờ PM promote lên staging').out, /phải DEPLOY/);
  assert.doesNotMatch(run(repo('docs/a.md'), 'p').out, /phải DEPLOY/);
});

test('contextTokensFromTail: usage cuối; compact_boundary hoặc /clear SAU usage ⇒ null; bỏ nhánh phụ', () => {
  const u = (n, extra = {}) => JSON.stringify({ type: 'assistant', ...extra, message: { usage: { input_tokens: 1, cache_read_input_tokens: n, cache_creation_input_tokens: 0 } } });
  const user = JSON.stringify({ type: 'user', message: { content: 'hi' } });
  const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });
  assert.equal(contextTokensFromTail([u(100), user].join('\n')), 101);
  assert.equal(contextTokensFromTail([u(558000), boundary, user].join('\n')), null);
  assert.equal(contextTokensFromTail([u(558000), JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }), user].join('\n')), null);
  assert.equal(contextTokensFromTail([u(558000), boundary, u(20000), user].join('\n')), 20001);
  assert.equal(contextTokensFromTail([u(5000), u(900000, { isSidechain: true })].join('\n')), 5001);
});
