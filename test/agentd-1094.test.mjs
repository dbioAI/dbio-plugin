import './helpers/hermetic.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDaemon } from '../lib/agentd/daemon.mjs';
import { normalizeConfig } from '../lib/agentd/config.mjs';
import { classifyFailure, parseResetAt } from '../lib/agentd/failure.mjs';
import { isWaitingCard, scanCards } from '../lib/agentd/patrol.mjs';
import { reconcileProcs } from '../lib/agentd/procs.mjs';
import { createRunLog } from '../lib/agentd/runlog.mjs';
import { classify, filterInbox, isApproveDecision, isDoneReport } from '../lib/watch-filter.mjs';
import { appendDropped, readDropped } from '../lib/stream/dropped.mjs';
import { stuckKindLine } from '../lib/staff-logic.mjs';

const work = mkdtempSync(join(tmpdir(), 't1094-'));
process.env.DBIO_STREAM_DIR = join(work, 'stream');
process.env.DBIO_AGENTD_STATUS = join(work, 'status.json');
process.env.DBIO_AGENTD_LOG_DIR = join(work, 'logs');

// 18/10/2026 10:00 giờ VN = 03:00Z
const T = Date.UTC(2026, 9, 18, 3, 0, 0);

test('#1094 (1) classifyFailure: "weekly limit · resets Oct 22, 9am" ⇒ quota + giờ reset theo Asia/Ho_Chi_Minh (UTC+7)', () => {
  const w = classifyFailure("You've hit your weekly limit · resets Oct 22, 9am (Asia/Saigon)", T);
  assert.equal(w.reason, 'quota'); assert.equal(w.window, 'weekly'); assert.equal(w.retry_at, '2026-10-22T02:00:00.000Z');
  const h = classifyFailure('5-hour limit reached ∙ resets 3pm', T);
  assert.equal(h.reason, 'quota'); assert.equal(h.window, '5h'); assert.equal(h.retry_at, '2026-10-18T08:00:00.000Z');
  const next = classifyFailure('5-hour limit reached ∙ resets 9am', T); // 9h sáng VN đã qua ⇒ ngày mai
  assert.equal(next.retry_at, '2026-10-19T02:00:00.000Z');
  assert.equal(classifyFailure('You have hit your limit. resets 11:30pm', T).retry_at, '2026-10-18T16:30:00.000Z');
  assert.equal(classifyFailure('Claude usage limit reached. reset in 2 hours', T).retry_at, '2026-10-18T05:00:00.000Z', 'dạng tương đối giữ nguyên');
  assert.equal(parseResetAt('không có giờ', T), null);
  assert.equal(parseResetAt('resets Foo 22, 9am', T), null);
});

function simDaemon({ accounts, out, wakes, calls }) {
  const adapter = { name: 'claude-sim', spawns: true, async wake() { wakes.push(1); return { ok: true, pid: process.pid, detail: 'sim', running: Promise.resolve({ code: 1, out, stdout: '' }) }; } };
  const { config } = normalizeConfig({ staff: { S1: { adapter: 'claude-sim', cwd: work } }, accounts, defaults: { coalesce_ms: 0, handoff: false, evidence_collect: false, spawn_grace_s: 0.05, retry_s: 0.2, max_slots: 3, chain_next: false } });
  const makeClient = (n) => ({ init: async () => 1, tb: async () => ({ data: { columns: [], tasks: [] } }), ai: async () => ({}), call: async (t, a) => { calls.push({ n, t, a }); return {}; } });
  return createDaemon({ loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {}, now: () => T, makeClient, getAdapter: (n) => (n === 'claude-sim' ? adapter : null), account: () => 'worker@dbio.ai', runsDir: join(work, `d-${Math.random().toString(36).slice(2)}`) });
}
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); } assert.fail('quá hạn chờ'); };

test('#1094 (1) mô phỏng hết hạn mức tuần (1 tài khoản) ⇒ hold tới giờ reset + thẻ blocked quota_limited + beat gửi reset_at + KHÔNG lượt rỗng', async () => {
  const wakes = []; const calls = [];
  const d = simDaemon({ accounts: undefined, out: "You've hit your weekly limit · resets Oct 22, 9am (Asia/Saigon)", wakes, calls });
  await d.load();
  await d.wakeNow('S1', 'việc', [{ task: '1#9', kind: 'assign' }]);
  await until(() => calls.some((c) => c.a.action === 'checkpoint'));
  const cp = calls.find((c) => c.a.action === 'checkpoint').a;
  assert.equal(cp.work_state.blocked, 'quota_limited'); assert.equal(cp.work_state.quota_reset_at, '2026-10-22T02:00:00.000Z'); assert.equal(cp.task_id, 9);
  assert.equal(d.quotaAllHeld(), '2026-10-22T02:00:00.000Z');
  // lượt kế: hold ngay, không gọi adapter (không lượt rỗng), không checkpoint lần 2
  const r = await d.wakeNow('S1', 'việc 2', [{ task: '1#9', kind: 'mention' }]);
  assert.equal(r.hold, true); assert.match(r.detail, /hết quota tới 2026-10-22/); assert.equal(wakes.length, 1);
  assert.equal(calls.filter((c) => c.a.action === 'checkpoint').length, 1, 'chỉ đánh dấu 1 lần / thẻ / mốc');
  // nhịp máy mang reset_at
  await d.workerBeat().catch(() => {});
  const beat = calls.find((c) => c.a.action === 'worker_beat')?.a.beat;
  assert.ok(beat, 'có nhịp'); const acc = beat.accounts[0];
  assert.equal(acc.retry_reason, 'quota'); assert.equal(acc.reset_at, '2026-10-22T02:00:00.000Z'); assert.equal(acc.limit_window, 'weekly');
});

test('#1094 (1) 2 tài khoản: tài khoản 1 hết hạn mức ⇒ chuyển tài khoản 2; hết cả hai ⇒ blocked quota_limited', async () => {
  const wakes = []; const calls = [];
  const accounts = [{ label: 'a1', config_dir: join(work, 'c1') }, { label: 'a2', config_dir: join(work, 'c2') }];
  const d = simDaemon({ accounts, out: "You've hit your weekly limit · resets Oct 22, 9am", wakes, calls });
  await d.load();
  await d.wakeNow('S1', 'x', [{ task: '1#9', kind: 'assign' }]);
  await until(() => d.acctState.a1?.reason === 'quota' || d.acctState.a2?.reason === 'quota');
  assert.equal(d.quotaAllHeld(), null, 'còn 1 tài khoản dùng được ⇒ chưa blocked'); assert.ok(!calls.some((c) => c.a.action === 'checkpoint'));
  await until(() => !d.st.get('S1').inflight); await d.wakeNow('S1', 'y', [{ task: '1#9', kind: 'mention' }]);
  await until(() => calls.some((c) => c.a.action === 'checkpoint'));
  assert.equal(wakes.length, 2); assert.equal(calls.find((c) => c.a.action === 'checkpoint').a.work_state.blocked, 'quota_limited');
  const r = await d.wakeNow('S1', 'z', [{ task: '1#9', kind: 'mention' }]); assert.equal(r.hold, true); assert.equal(wakes.length, 2);
});

test('#1094 (1) tuần tra KHÔNG claim/tiếp quản thẻ quota_limited; qua mốc reset thì tiếp quản lại', () => {
  const columns = [{ id: 1, name: 'Đã giao', position: 1 }, { id: 2, name: 'Đang làm', position: 2 }];
  const blocked = { id: 9, column_id: 2, title: 't', assignee: 'S1', updated_at: '2026-10-17 01:00:00', entered_column_at: '2026-10-17 01:00:00', work_state: { blocked: 'quota_limited', quota_reset_at: '2026-10-22T02:00:00.000Z' } };
  assert.equal(isWaitingCard(blocked, T), true);
  assert.equal(isWaitingCard(blocked, Date.parse('2026-10-22T02:00:01Z')), false, 'qua reset ⇒ không còn chờ');
  assert.equal(isWaitingCard({ work_state: { blocked: 'quota_limited', waiting: 'hết hạn mức, tự mở lại sau 2026-10-22T02:00:00.000Z' } }, T), true);
  const r = scanCards({ board: 1, tasks: [blocked], columns, name: 'S1', openCards: new Set(), now: T });
  assert.deepEqual(r.items, []);
});

test('#1094 (2) worker_beat lỗi mạng: thử lại 3 lần cách (rút ngắn) rồi MỘT dòng log gộp; phục hồi ⇒ 1 dòng; thành công ở lần thử lại ⇒ không log', async () => {
  const logs = []; let n = 0; let failAll = true;
  const { config } = normalizeConfig({ staff: { S1: { adapter: 'command', command: [process.execPath, '-v'] } }, defaults: {} });
  const makeClient = () => ({ init: async () => 1, tb: async () => ({}), ai: async () => ({}), call: async () => { n++; if (failAll || n === 1) throw new Error('fetch failed'); return {}; } });
  const d = createDaemon({ loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: (m) => logs.push(m), makeClient, beatRetryMs: 1, runsDir: join(work, 'beat') });
  await d.load();
  await d.workerBeat(); assert.equal(n, 4, '1 lần + 3 lần thử lại'); assert.equal(logs.filter((l) => /worker_beat/.test(l)).length, 1);
  await d.workerBeat(); await d.workerBeat(); assert.equal(logs.filter((l) => /worker_beat/.test(l)).length, 1, 'nhịp lỗi tiếp theo KHÔNG ghi thêm');
  failAll = false; n = 0; await d.workerBeat();
  assert.equal(n, 2, 'lỗi 1 lần rồi thành công ở lần thử lại'); assert.equal(logs.filter((l) => /^worker_beat phục hồi/.test(l)).length, 1);
});

test('#1094 (2) nhật ký lượt: lỗi mạng liên tiếp chỉ log 1 dòng + 1 dòng phục hồi', async () => {
  const logs = []; let fail = true;
  const rl = createRunLog({ runId: 'r1', send: async () => { if (fail) throw new Error('fetch failed'); return { accepted: 1 }; }, onLog: (m) => logs.push(m), setTimer: () => 0, clearTimer: () => {}, endTries: 1 });
  rl.feedLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }));
  await rl.flush(); await rl.flush(); await rl.flush();
  assert.equal(logs.filter((l) => /LỖI/.test(l)).length, 1);
  fail = false; await rl.flush(); assert.equal(logs.filter((l) => /^đẩy nhật ký phục hồi/.test(l)).length, 1);
});

test('#1094 (3) LỆCH: bỏ tiến trình/Run dưới 60s; báo khi lệch ≥2 nhịp liên tiếp', async () => {
  const cmd = 'C:\\x\\claude.exe -p --name NV1 --model m';
  const procs = [{ pid: 20, ppid: 1, started: T - 5_000, cmd }];                               // lượt vừa khởi động (5s) — shim/claude chưa đủ tuổi
  const young = reconcileProcs(procs, [], () => true, { now: T });
  assert.equal(young.named, 0); assert.equal(young.mismatch, false, 'tiến trình <60s không tính ⇒ không LỆCH');
  const youngRun = reconcileProcs([], [{ pid: 20, started_at: T - 5_000 }], () => true, { now: T });
  assert.equal(youngRun.open, 0); assert.equal(youngRun.mismatch, false);
  const old = reconcileProcs([{ pid: 20, ppid: 1, started: T - 90_000, cmd }], [], () => true, { now: T });
  assert.equal(old.mismatch, true, 'đủ tuổi mà không có Run ⇒ lệch thật');
  assert.equal(reconcileProcs([{ pid: 20, cmd }], [], () => true, { now: T }).mismatch, true, 'không biết mốc bắt đầu ⇒ vẫn đếm (như cũ)');
  // daemon: lệch 1 nhịp không log, nhịp thứ 2 mới log
  const logs = []; let n = 0; const { config } = normalizeConfig({ staff: {}, defaults: {} });
  const d = createDaemon({ loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: (m) => logs.push(m), listProcs: async () => { n++; return [{ pid: 20, ppid: 1, started: T - 120_000, cmd }]; }, now: (() => { let t = T; return () => (t += 60_000); })(), runsDir: join(work, 'lech') });
  await d.load();
  await d.checkProcs(); assert.equal(logs.filter((l) => /LỆCH/.test(l)).length, 0, 'nhịp 1 chưa báo');
  await d.checkProcs(); assert.equal(logs.filter((l) => /LỆCH/.test(l)).length, 1, 'nhịp 2 liên tiếp ⇒ báo');
  await d.checkProcs(); assert.equal(logs.filter((l) => /LỆCH/.test(l)).length, 1, 'cùng pid lạ ⇒ không báo lại');
  assert.equal(n, 3);
});

test('#1094 (4) listen của người duyệt: BÁO XONG/CHỜ DUYỆT có chữ "duyệt/xác nhận" KHÔNG bị lọc approved, luôn khẩn', () => {
  const body = '✅ BÁO XONG · NV1 · 2026-10-18T10:00:00Z\n1. Trạng thái: xong\n2. Mã: abc\n3. Bằng chứng: test xanh, đã xác nhận với PM, được duyệt phạm vi\n4. Nợ: không\n5. Việc kế: không';
  const it = { id: 77, kind: 'decision', task: '1#1094', text: body, at: '2026-10-18T10:00:00Z' };
  assert.equal(isApproveDecision(it), true, 'nếu không có ngoại lệ thì bộ lọc approved sẽ nuốt tin này (gốc lỗi 5 tin BÁO XONG bị lỡ)');
  assert.equal(isDoneReport(it), true);
  const r = filterInbox([it], { meId: 5, meName: 'PM', now: Date.parse(it.at) + 1000 });
  assert.equal(r.keep.length, 1, 'giữ'); assert.equal(r.keep[0].cls, 'urgent'); assert.deepEqual(r.drop, []);
  // PM vừa chạm thẻ ≤2 phút (touched) cũng không được nuốt báo xong
  const t2 = filterInbox([it], { meId: 5, meName: 'PM', touched: { 1094: Date.parse(it.at) - 20_000 }, now: Date.parse(it.at) + 1000 });
  assert.equal(t2.keep.length, 1);
  // tin dạng bình luận/mention (thường) mang báo xong cũng khẩn, không đợi gom 20'
  assert.equal(classify({ kind: 'comment', text: '✅ BÁO XONG · NV2 · x' }), 'urgent');
  assert.equal(classify({ kind: 'comment', text: 'ghi chú thường' }), 'normal');
  // DUYỆT thật của chủ vẫn bị lọc như cũ
  const real = filterInbox([{ id: 78, kind: 'decision', task: '1#5', text: 'Chủ đã duyệt thẻ', at: '2026-10-18T10:00:00Z' }], { meId: 5, meName: 'PM', now: Date.parse('2026-10-18T10:00:01Z') });
  assert.equal(real.drop[0]?.reason, 'approved');
});

test('#1094 (4) sổ tin bị lọc + listen --catchup đọc lại tin bỏ lỡ; nhiễu self/dup không vào sổ', async () => {
  const { spawn } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'catchup-')); const sd = join(home, 'stream'); process.env.DBIO_STREAM_DIR = sd; mkdirSync(sd, { recursive: true });
  const now = Date.now();
  appendDropped('PM', 'listen', [{ item: { id: 11, task: '1#5', kind: 'decision', text: 'Chủ đã duyệt thẻ' }, reason: 'approved' }, { item: { id: 12, task: '1#6', kind: 'mention', text: 'nhiễu' }, reason: 'self-ref' }, { item: { id: 13, task: '1#7', kind: 'mention', text: 'cũ' }, reason: 'dup' }], now);
  const got = readDropped('PM', 'listen', { now }); assert.deepEqual(got.map((x) => x.id), [11]);
  assert.deepEqual(readDropped('PM', 'listen', { now, afterId: 11 }), []);
  assert.deepEqual(readDropped('PM', 'listen', { now: now + 30 * 3_600_000 }), [], 'quá 24h không trả');
  writeFileSync(join(sd, 'PM.listen.pending.json'), JSON.stringify({ ids: [40, 41] }));
  const BIN = join(import.meta.dirname, '..', 'bin', 'dbio-staff.mjs');
  const env = { ...process.env, DBIO_STREAM_DIR: sd, HOME: home, USERPROFILE: home }; delete env.DBIO_AGENTD_TURN;
  const out = await new Promise((resolve) => { const p = spawn(process.execPath, [BIN, 'listen', '--as', 'PM', '--catchup'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; }); p.on('close', (code) => resolve({ code, o })); });
  assert.equal(out.code, 0, out.o); assert.match(out.o, /2 tin đã giao chưa ack \(id 40,41\)/); assert.match(out.o, /1 tin bộ lọc đã bỏ/); assert.match(out.o, /#11 .*bỏ vì approved.*Chủ đã duyệt/);
});

test('#1094 (5) stuckKindLine: ghi rõ giữ owner (GO cứng) hay hạ pm', () => {
  const a = stuckKindLine({ card: '1#9', who: 'NV1', asked: 'owner', applied: 'owner', reason: 'money', at: 'T' });
  const b = stuckKindLine({ card: '1#9', who: 'NV1', asked: 'owner', applied: 'pm', reason: undefined, at: 'T' });
  assert.match(a, /xin=owner ⇒ owner \(GO cứng: money\)/); assert.match(b, /xin=owner ⇒ pm \(hạ/);
});
