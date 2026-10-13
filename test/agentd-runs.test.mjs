import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDaemon } from '../lib/agentd/daemon.mjs';
import { normalizeConfig } from '../lib/agentd/config.mjs';
import { createRunStore, findResultJson, liveness, parseRunOutput, pidAlive, summarize } from '../lib/agentd/runs.mjs';

const work = mkdtempSync(join(tmpdir(), 'runs-'));
process.env.DBIO_STREAM_DIR = join(work, 'stream');
process.env.DBIO_AGENTD_STATUS = join(work, 'status.json');
process.env.DBIO_AGENTD_LOG_DIR = join(work, 'logs');

const OK_RESULT = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 4200, session_id: 'sess-aaa', total_cost_usd: 0.5, usage: { input_tokens: 9, output_tokens: 99 },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 2000, cacheCreationInputTokens: 300, costUSD: 0.4 }, 'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 20, costUSD: 0.1 } } };
const ERR_RESULT = { type: 'result', subtype: 'error_during_execution', is_error: true, api_error_code: 'rate_limited', terminal_reason: 'api_error', session_id: 'sess-bbb', usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} };

test('parseRunOutput: cộng usage THEO model thực (modelUsage), giữ cache_read/cache_write riêng', () => {
  const u = parseRunOutput(`warn: something\n${JSON.stringify(OK_RESULT)}\n`);
  assert.deepEqual(u.tokens, { input: 110, cache_read: 2000, cache_write: 320, output: 55 });
  assert.deepEqual(u.models.map((m) => m.model), ['claude-opus-5-5', 'claude-haiku-4-5-20251001']);
  assert.equal(u.session_id, 'sess-aaa'); assert.equal(u.is_error, false); assert.ok(Math.abs(u.cost_usd - 0.5) < 1e-9);
});

test('parseRunOutput: lượt LỖI (modelUsage rỗng, usage 0) ⇒ tokens = null, KHÔNG phải 0; đầu ra không JSON ⇒ mọi trường null', () => {
  const e = parseRunOutput(JSON.stringify(ERR_RESULT));
  assert.equal(e.tokens, null); assert.equal(e.cost_usd, null); assert.equal(e.is_error, true); assert.equal(e.error_code, 'rate_limited'); assert.deepEqual(e.models, []);
  for (const raw of ['', 'xin chào', '{"hỏng":', null, undefined]) { const n = parseRunOutput(raw); assert.equal(n.tokens, null); assert.equal(n.session_id, null); assert.equal(n.is_error, null); }
});

test('parseRunOutput: trường thiếu/âm/không phải số trong từng model ⇒ null, các trường còn lại vẫn cộng', () => {
  const u = parseRunOutput(JSON.stringify({ type: 'result', modelUsage: { m: { inputTokens: 5, outputTokens: -1, cacheReadInputTokens: 'x' } } }));
  assert.deepEqual(u.tokens, { input: 5, cache_read: null, cache_write: null, output: null });
});

test('findResultJson: lấy dòng JSON kết quả CUỐI, bỏ qua dòng nhiễu; chịu được JSON nhiều dòng', () => {
  assert.equal(findResultJson(`{"x":1}\n${JSON.stringify(OK_RESULT)}\nrác`)?.session_id, 'sess-aaa');
  assert.equal(findResultJson(JSON.stringify(OK_RESULT, null, 2))?.session_id, 'sess-aaa');
});

test('sổ Run: start → beat → end; open.json chỉ giữ run mở; lần thử tăng theo (nhân viên, thẻ); nhật ký tháng giữ ảnh chụp cuối', () => {
  let t = Date.UTC(2026, 9, 14, 10, 0, 0); const store = createRunStore({ dir: join(work, 's1'), now: () => t });
  const a = store.start({ staff: 'NV1', card: '162801#1036', adapter: 'claude-desktop', machine: 'M1', account: 'a@b.c' });
  assert.equal(a.attempt, 1); assert.equal(a.card, '162801#1036'); assert.equal(a.tokens, null); assert.equal(liveness(a, t), 'running');
  t += 100_000; assert.equal(liveness(store.get(a.run_id), t), 'lost', 'mất nhịp > 90s');
  store.beat(a.run_id, 90_000); assert.equal(liveness(store.get(a.run_id), t), 'running'); assert.equal(store.get(a.run_id).lease_until, t + 90_000);
  t += 5000; const e = store.end(a.run_id, { outcome: 'ok', exit_code: 0, usage: parseRunOutput(JSON.stringify(OK_RESULT)) });
  assert.equal(e.duration_ms, 105_000); assert.equal(e.tokens.cache_read, 2000); assert.equal(store.openRuns().length, 0);
  assert.equal(JSON.parse(readFileSync(join(work, 's1', 'open.json'), 'utf8'))[a.run_id], undefined);
  const b = store.start({ staff: 'NV1', card: '162801#1036', adapter: 'claude-desktop', machine: 'M1' }); assert.equal(b.attempt, 2);
  const c = store.start({ staff: 'NV1', card: 'không-phải-thẻ', adapter: 'command', machine: 'M1' }); assert.equal(c.card, null); assert.equal(c.attempt, null);
  const list = store.list(); assert.equal(list.length, 3); assert.equal(list.find((r) => r.run_id === a.run_id).outcome, 'ok');
  assert.equal(createRunStore({ dir: join(work, 's1'), now: () => t }).openRuns().length, 2, 'sống qua khởi động lại');
});

test('summarize: tỉ lệ run có usage thật; lượt lost/spawn_failed không tính mẫu số; token cộng, thiếu thì null', () => {
  const mk = (o, tok) => ({ ended_at: 1, outcome: o, tokens: tok, models: tok ? [{ model: 'm' }] : [], error_code: null });
  const s = summarize([mk('ok', { input: 1, cache_read: 2, cache_write: 3, output: 4 }), mk('ok', { input: 1, cache_read: null, cache_write: null, output: 1 }), mk('error', null), mk('lost', null), mk('spawn_failed', null), { outcome: null, ended_at: null }]);
  assert.equal(s.measurable, 3); assert.equal(s.with_usage, 2); assert.equal(s.usage_pct, 66.7); assert.equal(s.running, 1);
  assert.deepEqual(s.tokens, { input: 2, cache_read: 2, cache_write: 3, output: 5 }); assert.deepEqual(summarize([]).tokens, null);
});

test('pidAlive: tiến trình hiện tại sống; pid rác/null thì không', () => {
  assert.equal(pidAlive(process.pid), true); assert.equal(pidAlive(null), false); assert.equal(pidAlive(-5), false); assert.equal(pidAlive(2 ** 22 + 12345), false);
});

// ===== tích hợp daemon (adapter command: script in ra JSON kết quả như `claude -p --output-format json`) =====
function script(name, { result, sleepMs = 0, code = 0 }) {
  const f = join(work, `${name}.mjs`);
  writeFileSync(f, `process.stdin.resume(); process.stdin.on('end',()=>{ setTimeout(()=>{ ${result ? `console.log(${JSON.stringify(JSON.stringify(result))});` : ''} process.exit(${code}); }, ${sleepMs}); });`);
  return f;
}
function mkDaemon(staff, defaults = {}, extra = {}) {
  const { config } = normalizeConfig({ staff, defaults: { coalesce_ms: 0, retry_s: 0.2, spawn_grace_s: 0.2, ...defaults } });
  return createDaemon({ loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {}, runsDir: join(work, `d-${Math.random().toString(36).slice(2)}`), account: () => 'worker@dbio.ai', ...extra });
}
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); } assert.fail('quá hạn chờ'); };

test('daemon: lượt thức ⇒ 1 Run có pid/máy/tài khoản + usage ĐO từ đầu ra; lượt lỗi API ⇒ tokens null (không 0)', async () => {
  const d = mkDaemon({ A: { adapter: 'command', command: [process.execPath, script('ok1', { result: OK_RESULT })] }, B: { adapter: 'command', command: [process.execPath, script('err1', { result: ERR_RESULT, code: 1 })] } });
  await d.load();
  await d.wakeNow('A', 'việc 1'); await until(() => d.runs.list().some((r) => r.staff === 'A' && r.ended_at));
  const a = d.runs.list().find((r) => r.staff === 'A');
  assert.equal(a.outcome, 'ok'); assert.equal(a.exit_code, 0); assert.ok(a.pid > 0); assert.equal(a.account, null, 'adapter command không phải claude ⇒ không gán tài khoản'); assert.equal(a.engine, 'command');
  assert.deepEqual(a.tokens, { input: 110, cache_read: 2000, cache_write: 320, output: 55 }); assert.equal(a.session_id, 'sess-aaa'); assert.ok(a.duration_ms >= 0);
  await d.wakeNow('B', 'việc 2'); await until(() => d.runs.list().some((r) => r.staff === 'B' && r.ended_at));
  const b = d.runs.list().find((r) => r.staff === 'B'); assert.equal(b.outcome, 'error'); assert.equal(b.tokens, null); assert.equal(b.error_code, 'rate_limited');
  assert.equal(d.runs.openRuns().length, 0);
});

test('daemon: đầu ra không có JSON (CLI cũ/cắt) ⇒ usage TRỐNG, không bịa', async () => {
  const d = mkDaemon({ C: { adapter: 'command', command: [process.execPath, script('plain', {})] } });
  await d.load(); await d.wakeNow('C', 'x'); await until(() => d.runs.list().some((r) => r.ended_at));
  const r = d.runs.list()[0]; assert.equal(r.outcome, 'ok'); assert.equal(r.tokens, null); assert.equal(r.cost_usd, null); assert.deepEqual(r.models, []);
});

test('daemon: trần max_slots — lượt thứ 2 bị HOÃN (không tính thất bại, không chạy), xong lượt 1 thì chạy được', async () => {
  const d = mkDaemon({ S1: { adapter: 'command', command: [process.execPath, script('slow1', { result: OK_RESULT, sleepMs: 1200 })] }, S2: { adapter: 'command', command: [process.execPath, script('slow2', { result: OK_RESULT })] } }, { max_slots: 1, spawn_grace_s: 0.1 });
  await d.load();
  const r1 = await d.wakeNow('S1', 'a'); assert.ok(r1.ok); assert.equal(d.slotRuns().length, 1);
  const r2 = await d.wakeNow('S2', 'b'); assert.equal(r2.ok, false); assert.equal(r2.hold, true); assert.match(r2.detail, /HOÃN.*1 slot.*S1/);
  assert.equal(d.st.get('S2').failures, 0, 'HOÃN không phải thất bại'); assert.equal(d.runs.list().filter((r) => r.staff === 'S2').length, 0);
  await until(() => d.slotRuns().length === 0, 8000);
  d.st.get('S2').retryAt = 0; const r3 = await d.wakeNow('S2', 'b'); assert.ok(r3.ok, 'hết slot thì chạy');
  await until(() => d.runs.list().filter((r) => r.ended_at).length === 2);
});

test('daemon: thẻ của run sang "Cần anh xử lý" ⇒ TRẢ slot (thẻ giữ nguyên người cầm); quay lại Đang làm ⇒ chiếm lại', async () => {
  const columns = [{ id: 1, name: 'Đang làm' }, { id: 2, name: 'Cần anh xử lý' }]; let col = 1;
  const makeClient = () => ({ init: async () => 162801, tb: async () => ({ data: { columns, tasks: [{ id: 1036, column_id: col }] } }), ai: async () => ({}), call: async () => ({}) });
  const d = mkDaemon({ W: { adapter: 'command', command: [process.execPath, script('long', { result: OK_RESULT, sleepMs: 2500 })] } }, { max_slots: 1, spawn_grace_s: 0.1 }, { makeClient });
  await d.load();
  await d.wakeNow('W', '[dbio-agentd] x'); // không có events ⇒ gắn thẻ qua run.update bên dưới
  const run = d.runs.openRuns()[0]; d.runs.update(run.run_id, { card: '162801#1036' });
  await d.reconcileRuns(); assert.equal(d.slotRuns().length, 1); assert.equal(d.runs.get(run.run_id).card_col, 'Đang làm');
  col = 2; await d.reconcileRuns(); assert.equal(d.slotRuns().length, 0, 'chờ chủ ⇒ trả slot'); assert.ok(d.runs.get(run.run_id).slot_returned_at);
  col = 1; await d.reconcileRuns(); assert.equal(d.slotRuns().length, 1, 'chủ trả lời, thẻ quay lại làm ⇒ chiếm lại');
  await until(() => d.runs.openRuns().length === 0, 8000);
});

test('daemon: run mồ côi của daemon cũ — pid đã mất ⇒ đóng "lost" (usage null); pid còn (nhận lại) ⇒ lease_gen+1, vẫn mở', async () => {
  const dir = join(work, 'orphans'); const store = createRunStore({ dir });
  const dead = store.start({ staff: 'X', card: '1#2', adapter: 'claude-desktop', machine: 'M' }); store.update(dead.run_id, { pid: 2 ** 22 + 777 });
  const live = store.start({ staff: 'Y', card: '1#3', adapter: 'claude-desktop', machine: 'M' }); store.update(live.run_id, { pid: process.pid });
  const { config } = normalizeConfig({ staff: {}, defaults: {} });
  const d = createDaemon({ loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {}, runs: createRunStore({ dir }) });
  await d.start();
  try {
    const rs = d.runs.list(); const x = rs.find((r) => r.run_id === dead.run_id); const y = rs.find((r) => r.run_id === live.run_id);
    assert.equal(x.outcome, 'lost'); assert.equal(x.error_code, 'process_gone'); assert.equal(x.tokens, null); assert.ok(x.ended_at);
    assert.equal(y.ended_at, null); assert.equal(y.lease_gen, 2); assert.equal(y.adopted, true);
    const st = JSON.parse(readFileSync(process.env.DBIO_AGENTD_STATUS, 'utf8')); assert.equal(st.slots.max, 3); assert.equal(st.runs.length, 1); assert.equal(st.runs[0].staff, 'Y');
  } finally { d.stop(); }
});
