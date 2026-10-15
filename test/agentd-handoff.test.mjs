import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const work = mkdtempSync(join(tmpdir(), 'handoff-'));
process.env.DBIO_STREAM_DIR = join(work, 'stream');
process.env.DBIO_AGENTD_STATUS = join(work, 'status.json');
process.env.DBIO_AGENTD_LOG_DIR = join(work, 'logs');
process.env.DBIO_AGENTD_RUNS_DIR = join(work, 'runs');
process.env.DBIO_NUDGED = join(work, 'nudged.json');
process.env.DBIO_ROLES_FILE = join(tmpdir(), 'khong-co-roles.json');
const { buildHandoff, fetchHandoff, workStateChanged, renderHandoffPrompt, HANDOFF_MAX_TOKENS, estTokens } = await import('../lib/agentd/handoff.mjs');
const { resumeVerdict, DEFAULT_RESUME_MAX_BYTES } = await import('../lib/agentd/context-size.mjs');
const { getAdapter } = await import('../lib/agentd/adapters/index.mjs');
const { createDaemon } = await import('../lib/agentd/daemon.mjs');
const { normalizeConfig } = await import('../lib/agentd/config.mjs');
const { createRunStore } = await import('../lib/agentd/runs.mjs');
const { runStream } = await import('../lib/stream/session.mjs');
const { evt, hello, startFakeServer, waitFor } = await import('./helpers/fake-stream-server.mjs');

const task = (over = {}) => ({ id: 7, title: 'Việc thử', priority: 2, column: { name: 'Đang làm' }, description: 'mô tả', work_state: { at: '2026-10-15 08:00:00', by: 'NV1', branch: 'main', head: 'abcdef123', pushed: true, next: 'làm bước B' }, comments: [{ at: 't1', by: 'PM', body: 'một' }, { at: 't2', by: 'NV1', body: '▶️ dbio-agentd: lượt ngầm BẮT ĐẦU' }, { at: 't3', by: 'PM', body: 'hai' }, { at: 't4', by: 'PM', body: 'ba' }, { at: 't5', by: 'PM', body: 'bốn' }], ...over });

test('buildHandoff: work_state + 3 bình luận cuối (bỏ dòng agentd), ≤ 1.500 token ngay cả khi thẻ rất dài', () => {
  const h = buildHandoff(task(), { card: '162801#7' });
  assert.match(h.text, /Thẻ 162801#7 Việc thử/); assert.match(h.text, /kế tiếp: làm bước B/); assert.match(h.text, /head abcdef1/);
  assert.ok(!h.text.includes('dbio-agentd')); assert.ok(!h.text.includes('một') && h.text.includes('hai') && h.text.includes('ba') && h.text.includes('bốn'), '3 bình luận cuối còn lại');
  assert.equal(h.ws_at, '2026-10-15 08:00:00');
  const big = buildHandoff(task({ description: 'x'.repeat(50_000), comments: Array.from({ length: 5 }, (_, i) => ({ at: i, by: 'a', body: 'y'.repeat(9000) })) }));
  assert.ok(big.tokens <= HANDOFF_MAX_TOKENS && estTokens(big.text) <= HANDOFF_MAX_TOKENS);
  assert.match(buildHandoff(task({ work_state: null })).text, /CHƯA có/); assert.equal(buildHandoff(null), null);
});

test('fetchHandoff / workStateChanged: đọc thẻ qua client; lỗi ⇒ null, không ném', async () => {
  const calls = []; const mkc = (t) => ({ init: async () => 1, tb: async (a, args) => { calls.push([a, args]); if (t instanceof Error) throw t; return { task: t }; } });
  const h = await fetchHandoff(mkc(task()), '162801#7'); assert.ok(h.text.includes('Việc thử')); assert.equal(calls[0][1].task_id, 7);
  assert.equal(await fetchHandoff(mkc(new Error('mạng')), '162801#7'), null); assert.equal(await fetchHandoff(mkc(task()), 'không-phải-thẻ'), null);
  assert.equal(await workStateChanged(mkc(task()), '1#7', '2026-10-15 08:00:00'), false, 'cùng at ⇒ chưa ghi hồ sơ');
  assert.equal(await workStateChanged(mkc(task()), '1#7', '2026-10-14 01:00:00'), true);
  assert.equal(await workStateChanged(mkc(task({ work_state: null })), '1#7', null), false);
  assert.equal(await workStateChanged(mkc(new Error('x')), '1#7', null), null, 'không đọc được ⇒ không kết luận');
});

test('resumeVerdict: chỉ resume khi CÙNG thẻ và tệp < ngưỡng byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'proj-')); mkdirSync(join(root, 'D--x'));
  writeFileSync(join(root, 'D--x', 'nho.jsonl'), 'a'.repeat(1000)); writeFileSync(join(root, 'D--x', 'to.jsonl'), 'a'.repeat(DEFAULT_RESUME_MAX_BYTES + 1));
  assert.equal(DEFAULT_RESUME_MAX_BYTES, 204_800);
  assert.equal(resumeVerdict({ session: 'nho', card: '1#7', prevCard: '1#7', root }).ok, true);
  assert.equal(resumeVerdict({ session: 'to', card: '1#7', prevCard: '1#7', root }).ok, false);
  assert.equal(resumeVerdict({ session: 'to', card: '1#7', prevCard: '1#7', root, maxBytes: 10 * DEFAULT_RESUME_MAX_BYTES }).ok, true, 'ngưỡng cấu hình được');
  assert.match(resumeVerdict({ session: 'nho', card: '1#8', prevCard: '1#7', root }).why, /khác thẻ/);
  assert.equal(resumeVerdict({ session: 'nho', card: '1#7', prevCard: null, root }).ok, false);
  assert.equal(resumeVerdict({ session: 'nho', card: null, prevCard: null, root }).ok, false);
  assert.equal(resumeVerdict({ session: 'mat', card: '1#7', prevCard: '1#7', root }).ok, false);
});

function fakeSpawn() {
  const calls = [];
  const fn = (bin, args, opts) => {
    const child = new EventEmitter(); child.pid = 4244; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let stdin = ''; child.stdin = Object.assign(new EventEmitter(), { end(x) { stdin = x ?? ''; setImmediate(() => { child.stdout.emit('data', Buffer.from('{"type":"result","session_id":"moi-1"}')); child.emit('close', 0); }); } });
    child.kill = () => {}; calls.push({ bin, args, opts, get stdin() { return stdin; } });
    return child;
  };
  return { fn, calls };
}

test('adapter: phiên ghim có ngữ cảnh — cùng thẻ + nhỏ ⇒ --resume; khác thẻ / lớn / chưa có Run trước ⇒ phiên MỚI + phiếu bàn giao (handoff_tokens)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sess-')); const dir = join(root, 'a', 'o'); mkdirSync(dir, { recursive: true });
  const proj = mkdtempSync(join(tmpdir(), 'proj-')); mkdirSync(join(proj, 'D--x'));
  writeFileSync(join(dir, 'local_p.json'), JSON.stringify({ sessionId: 'local_p', cliSessionId: 'cli-p', cwd: 'D:\\x' }));
  writeFileSync(join(proj, 'D--x', 'cli-p.jsonl'), 'a'.repeat(5000));
  const entry = { session: 'local_p', sessions_dir: root, projects_dir: proj, spawn_dir: mkdtempSync(join(tmpdir(), 'spd-')) };
  const ad = getAdapter('claude-desktop'); const handoff = buildHandoff(task(), { card: '1#7' });
  const ev = [{ task: '1#7', kind: 'assign' }];
  const a = fakeSpawn(); await ad.wake({ staff: 'NV1', entry, prompt: 'p', events: ev, spawnFn: a.fn, handoff, prevCard: '1#7' });
  assert.deepEqual(a.calls[0].args.slice(0, 2), ['--resume', 'cli-p'], 'cùng thẻ + nhỏ ⇒ resume');
  for (const [label, over] of [['khác thẻ', { prevCard: '1#6' }], ['chưa có Run trước', { prevCard: null }], ['quá lớn', { prevCard: '1#7', resumeMaxBytes: 1000 }]]) {
    const b = fakeSpawn(); const r = await ad.wake({ staff: 'NV1', entry, prompt: 'tin mới', events: ev, spawnFn: b.fn, handoff, ...over });
    assert.ok(!b.calls[0].args.includes('--resume'), label); assert.equal(r.spawnNew, true, label); assert.equal(r.handoff_tokens, handoff.tokens, label);
    assert.ok(b.calls[0].stdin.includes('=== PHIẾU BÀN GIAO ===') && b.calls[0].stdin.includes('kế tiếp: làm bước B') && b.calls[0].stdin.includes('tin mới') && b.calls[0].stdin.includes('checkpoint'), label);
  }
  const c = fakeSpawn(); await ad.wake({ staff: 'NV1', entry: { ...entry, allow_large: true }, prompt: 'p', events: ev, spawnFn: c.fn, handoff, prevCard: '9#9' });
  assert.deepEqual(c.calls[0].args.slice(0, 2), ['--resume', 'cli-p'], 'allow_large ⇒ như cũ');
});

test('adapter claude-cli: có phiếu + cwd ⇒ mặc định phiên MỚI; cùng thẻ + nhỏ ⇒ --resume', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-')); mkdirSync(join(proj, 'D--x')); writeFileSync(join(proj, 'D--x', 'cli-q.jsonl'), 'a'.repeat(3000));
  const entry = { session: 'cli-q', cwd: 'D:\\x', projects_dir: proj }; const ad = getAdapter('claude-cli'); const handoff = buildHandoff(task(), { card: '1#7' }); const ev = [{ task: '1#7' }];
  const a = fakeSpawn(); const ra = await ad.wake({ staff: 'NV1', entry, prompt: 'p', events: ev, spawnFn: a.fn, handoff, prevCard: '1#6' });
  assert.ok(ra.ok && ra.spawnNew && !a.calls[0].args.includes('--resume') && a.calls[0].stdin.includes('PHIẾU BÀN GIAO'));
  const b = fakeSpawn(); await ad.wake({ staff: 'NV1', entry, prompt: 'p', events: ev, spawnFn: b.fn, handoff, prevCard: '1#7' });
  assert.deepEqual(b.calls[0].args.slice(0, 2), ['--resume', 'cli-q']);
});

test('renderHandoffPrompt: một lượt thay — nội dung phiếu chứa {prompt} không bị thay lần hai', () => {
  const t = renderHandoffPrompt('NV1', 'phiếu {prompt} {name}', 'TIN'); assert.ok(t.includes('phiếu {prompt} {name}') && t.includes('Tin vừa tới: TIN') && t.includes('--as "NV1"'));
});

test('daemon: lượt xong êm nhưng thẻ KHÔNG có work_state mới ⇒ Run needs_review; có work_state mới ⇒ ok; ghi handoff_tokens + resumed', async () => {
  for (const [wsAfter, want] of [['2026-10-15 08:00:00', 'needs_review'], ['2026-10-15 09:30:00', 'ok']]) {
    const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
    const name = `T1044_${process.pid}_${want}`; const woken = []; let reads = 0;
    const { config } = normalizeConfig({ staff: { [name]: { adapter: 'fake', session: 's1' } }, defaults: { coalesce_ms: 0 } });
    const out = '{"type":"result","is_error":false}';
    const d = createDaemon({
      loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {},
      makeClient: () => ({ init: async () => 1, ai: async (tool, a) => ({ items: (a.ids ?? []).map((id) => ({ id, kind: 'assign', text: 'x', at: new Date().toISOString() })) }), call: async () => ({}), tb: async (a) => { if (a !== 'task_get') return {}; reads++; return { task: task({ work_state: { at: reads === 1 ? '2026-10-15 08:00:00' : wsAfter } }) }; } }),
      getAdapter: () => ({ name: 'fake', wake: async (ctx) => { woken.push(ctx); return { ok: true, detail: 'ok', pid: process.pid, handoff_tokens: ctx.handoff?.tokens ?? null, spawnNew: true, running: Promise.resolve({ code: 0, out, stdout: out }) }; } }),
      stream: (o) => runStream({ ...o, cfg: { key: 'sk_p2_abcdefghijklmnopqrstuvwxyz0123456789', mcp_url: srv.mcpUrl }, tickMs: 20 }),
    });
    try {
      await d.start(); await waitFor(() => srv.conns.length === 1); srv.conns[0].send(evt(1, { task: '1#7' }));
      await waitFor(() => woken.length === 1, 8000);
      assert.ok(woken[0].handoff?.text.includes('Việc thử') && woken[0].resumeMaxBytes === 204_800 && woken[0].prevCard === null);
      const store = createRunStore({ dir: process.env.DBIO_AGENTD_RUNS_DIR });
      await waitFor(() => store.list({ staff: name }).some((r) => r.ended_at), 15000);
      const r = store.list({ staff: name })[0];
      assert.equal(r.outcome, want); assert.equal(r.resumed, false); assert.ok(r.handoff_tokens > 0);
    } finally { d.stop(); await srv.stop(); }
  }
});
