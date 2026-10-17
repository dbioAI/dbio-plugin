import './helpers/hermetic.mjs';
// #1082 — agentd chọn adapter ĐÚNG theo runtime khai cứng (claude_cli | claude_desktop); cách ly, KHÔNG spawn claude thật.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDaemon, runtimeOfEntry } from '../lib/agentd/daemon.mjs';
import { normalizeConfig } from '../lib/agentd/config.mjs';
import { adapterForRosterEntry, requiresViolation, rosterToStaff, runtimeOf } from '../lib/agentd/roster.mjs';
import { lostPin } from '../lib/agentd/adapters/claude-desktop.mjs';
import { runStream } from '../lib/stream/session.mjs';
import { evt, hello, startFakeServer, waitFor } from './helpers/fake-stream-server.mjs';

const work = mkdtempSync(join(tmpdir(), 'runtime-'));
process.env.DBIO_STREAM_DIR = join(work, 'stream');
process.env.DBIO_AGENTD_STATUS = join(work, 'status.json');
process.env.DBIO_AGENTD_LOG_DIR = join(work, 'logs');
process.env.DBIO_AGENTD_RUNS_DIR = join(work, 'runs');
process.env.DBIO_AGENTD_LEASE_DIR = join(work, 'lease');
const KEY = 'sk_p2_abcdefghijklmnopqrstuvwxyz0123456789';
let n = 0; const uniq = () => `T1082_rt_${process.pid}_${++n}`;
const S = (name, o = {}) => ({ id: 1, name, role: 'dev', enabled: true, ...o });

test('roster: runtime khai cứng quyết định adapter — claude_cli luôn claude-cli (bỏ session_ref cũ), claude_desktop luôn claude-desktop gửi vào session_ref', () => {
  assert.equal(adapterForRosterEntry(S('A', { runtime: 'claude_cli' })), 'claude-cli');
  assert.equal(adapterForRosterEntry(S('A', { runtime: { agent: 'claude_cli' }, session_ref: 'local_cu' })), 'claude-cli', 'session_ref cũ KHÔNG biến CLI thành desktop');
  assert.equal(adapterForRosterEntry(S('A', { runtime: { agent: 'claude_desktop' }, session_ref: 'local_x' })), 'claude-desktop');
  assert.equal(adapterForRosterEntry(S('A', { runtime: 'claude_desktop' })), 'claude-desktop', 'desktop thiếu session_ref ⇒ vẫn desktop (adapter báo mất phiên ghim), KHÔNG rơi xuống CLI');
  assert.equal(adapterForRosterEntry(S('A', { runtime: 'claude_desktop', enabled: false })), null);
  assert.equal(adapterForRosterEntry(S('A', { agent: 'codex' })), 'codex');
  assert.equal(adapterForRosterEntry(S('A', { agent: 'desktop', session_ref: 'local_x' })), 'claude-cli', 'payload cũ chưa có runtime cứng: không suy diễn desktop từ session_ref');
  assert.equal(runtimeOf(S('A', { runtime: 'CLAUDE_DESKTOP' })), 'claude_desktop'); assert.equal(runtimeOf(S('A', { runtime: 'lạ' })), null);
  const m = rosterToStaff({ staff: [S('NV1', { runtime: 'claude_cli', session_ref: 'local_cu' }), S('Cua', { runtime: 'claude_desktop', session_ref: 'local_9' }), S('Mat', { runtime: 'claude_desktop' })] });
  assert.equal(m.NV1.adapter, 'claude-cli'); assert.equal(m.NV1.runtime, 'claude_cli'); assert.equal(m.NV1.session, undefined, 'CLI không mang session_ref');
  assert.equal(m.Cua.adapter, 'claude-desktop'); assert.equal(m.Cua.runtime, 'claude_desktop'); assert.equal(m.Cua.session, 'local_9');
  assert.equal(m.Mat.adapter, 'claude-desktop'); assert.equal(m.Mat.session, undefined);
  assert.equal(runtimeOfEntry({ adapter: 'claude-desktop' }), 'claude_desktop'); assert.equal(runtimeOfEntry({ adapter: 'claude-cli', runtime: 'claude_cli' }), 'claude_cli'); assert.equal(runtimeOfEntry({ adapter: 'codex' }), null);
});

test('requires: browser_app / computer_use / owner_watch chỉ claude_desktop làm được (chuỗi, mảng hoặc đối tượng)', () => {
  assert.match(requiresViolation('claude_cli', ['browser_app']), /browser_app/);
  assert.match(requiresViolation('claude_cli', 'x, computer_use'), /computer_use/);
  assert.match(requiresViolation('claude_cli', { owner_watch: true }), /owner_watch/);
  assert.match(requiresViolation(null, { tools: ['browser_app'] }), /runtime chưa khai/);
  assert.equal(requiresViolation('claude_desktop', ['browser_app', 'computer_use']), null);
  assert.equal(requiresViolation('claude_cli', null), null);
  assert.equal(requiresViolation('claude_cli', { resources: [{ repo: 'backend', mode: 'mutate' }] }), null, 'requires kiểu repo/lease không bị chặn');
});

/** Daemon giả: 1 nhân viên, adapter giả, client ghi lại mọi lệnh sổ cái. */
async function run({ entry, adapter, handoffRequires = null, events = [{ task: '162801#9' }] }) {
  const srv = await startFakeServer({ onConnect: (c) => c.send(hello(0)) });
  const name = uniq(); const posted = []; const woken = []; const records = [];
  const { config } = normalizeConfig({ staff: { [name]: entry }, defaults: { coalesce_ms: 0, retry_s: 0.05, relay_to: 'PM giao việc' } });
  const d = createDaemon({
    loadCfg: () => ({ config, errors: [] }), hasKey: () => true, log: () => {},
    makeClient: () => ({
      init: async () => 162801,
      tb: async (a) => (a === 'task_get' ? { task: { id: 9, title: 't', requires: handoffRequires, comments: [] } } : {}),
      ai: async (tool, a) => ({ items: (a.ids ?? []).map((id) => ({ id, kind: 'assign', text: 'x', task: '162801#9', at: new Date().toISOString() })) }),
      call: async (tool, a) => { if (a.action === 'run_record') records.push(a); else if (!['worker_beat', 'run_event'].includes(a.action)) posted.push(a); return {}; },
    }),
    getAdapter: () => ({ ...adapter, wake: async (ctx) => { woken.push(ctx); return adapter.wake(ctx); } }),
    stream: (o) => runStream({ ...o, cfg: { key: KEY, mcp_url: srv.mcpUrl }, tickMs: 20 }),
  });
  await d.start(); await waitFor(() => srv.conns.length === 1); srv.conns[0].send(evt(1, { task: '162801#9', ...events[0] }));
  return { d, srv, posted, woken, records, name, stop: async () => { d.stop(); await srv.stop(); } };
}

test('desktop MẤT phiên ghim ⇒ KẸT --kind pm (checkpoint blocked=pm + bình luận @PM), log đỏ, KHÔNG gọi/spawn phiên headless thay thế', async () => {
  const t = await run({ entry: { adapter: 'claude-desktop', runtime: 'claude_desktop', session: 'local_mat' }, adapter: { name: 'claude-desktop', spawns: false, claims: true, isBlank: () => false, activeAgoMs: () => null, wake: async ({ staff }) => lostPin(staff, 'không thấy phiên local_mat') } });
  try {
    await waitFor(() => t.posted.some((p) => p.action === 'comment_add'), 8000);
    const cp = t.posted.find((p) => p.action === 'checkpoint'); assert.equal(cp.work_state.blocked, 'pm'); assert.match(cp.work_state.waiting, /mất phiên ghim/);
    const cm = t.posted.find((p) => p.action === 'comment_add'); assert.match(cm.body, /KẸT: pm/); assert.match(cm.body, /mất phiên ghim/); assert.match(cm.body, /@PM giao việc/); assert.match(cm.body, /KHÔNG tự thay/);
    assert.ok(t.woken.length >= 1); assert.ok(t.woken.every((w) => w.entry.adapter === 'claude-desktop'), 'chỉ adapter desktop được gọi');
    assert.equal(t.d.writeStatus().staff[t.name].adapter, 'claude-desktop');
    assert.match(t.d.writeStatus().staff[t.name].last_error, /MẤT PHIÊN GHIM/);
    await new Promise((r) => setTimeout(r, 300)); assert.equal(t.posted.filter((p) => p.action === 'comment_add').length, 1, 'báo 1 lần / giờ, không spam');
  } finally { await t.stop(); }
});

test('thẻ requires browser_app rơi vào NV claude_cli (dữ liệu cũ) ⇒ TỪ CHỐI mở lượt (adapter không được gọi) + báo PM; NV desktop thì chạy', async () => {
  const cli = await run({ entry: { adapter: 'claude-cli', runtime: 'claude_cli', cwd: work }, handoffRequires: ['browser_app'], adapter: { name: 'claude-cli', spawns: true, wake: async () => ({ ok: true, detail: 'ok' }) } });
  try {
    await waitFor(() => cli.posted.some((p) => p.action === 'comment_add'), 8000);
    assert.match(cli.posted.find((p) => p.action === 'comment_add').body, /từ chối mở lượt.*browser_app/s);
    assert.equal(cli.woken.length, 0, 'không chạy claude');
    assert.match(cli.d.writeStatus().staff[cli.name].last_error, /TỪ CHỐI mở lượt/);
  } finally { await cli.stop(); }
  const desk = await run({ entry: { adapter: 'claude-desktop', runtime: 'claude_desktop', session: 'local_x' }, handoffRequires: ['browser_app'], adapter: { name: 'claude-desktop', spawns: false, claims: true, isBlank: () => false, activeAgoMs: () => null, wake: async () => ({ ok: true, detail: 'ok' }) } });
  try {
    await waitFor(() => desk.woken.length === 1, 8000);
    assert.ok(!desk.posted.some((p) => p.action === 'comment_add' && /từ chối/.test(p.body ?? '')));
  } finally { await desk.stop(); }
});

test('desktop wake có tiến trình ⇒ ghi Run tối thiểu (claim + bắt đầu/kết thúc) dù đầu ra không phải stream-json', async () => {
  const t = await run({
    entry: { adapter: 'claude-desktop', runtime: 'claude_desktop', session: 'local_x' },
    adapter: { name: 'claude-desktop', spawns: false, claims: true, isBlank: () => false, activeAgoMs: () => null, wake: async () => ({ ok: true, detail: 'ok', pid: process.pid, running: Promise.resolve({ code: 0, stdout: 'không phải JSON', out: '' }) }) },
  });
  try {
    await waitFor(() => t.d.writeStatus().staff[t.name].wakes >= 1, 8000);
    await waitFor(() => t.records.length >= 2, 8000); // claim trước khi chạy + kết thúc
    const st = t.d.writeStatus(); assert.equal(st.staff[t.name].adapter, 'claude-desktop');
  } finally { await t.stop(); }
});
