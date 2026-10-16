import './helpers/hermetic.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDaemon } from '../lib/agentd/daemon.mjs';
import { effectiveStaff, migrateConfig, normalizeConfig } from '../lib/agentd/config.mjs';
import { adapterForRosterEntry, loadMachineKey, rosterToStaff, staffKeyPath } from '../lib/agentd/roster.mjs';

const work = mkdtempSync(join(tmpdir(), 'roster-'));
process.env.DBIO_AGENTD_STATUS = join(work, 'status.json');
process.env.DBIO_AGENTD_LOG_DIR = join(work, 'logs');
process.env.DBIO_AGENTD_RUNS_DIR = join(work, 'runs');
process.env.DBIO_AGENTD_LEASE_DIR = join(work, 'lease');
const MK = { key: 'mk_abcdefghijklmnopqrstuvwxyz0123456789', mcp_url: 'https://x.test/mcp', source: 'file' };
const S = (name, o = {}) => ({ id: 1, name, role: 'dev', agent: 'cli', enabled: true, ...o });

test('adapter: mặc định CLI; claude-desktop CHỈ khi agent desktop + session_ref; enabled=false bỏ', () => {
  assert.equal(adapterForRosterEntry(S('A')), 'claude-cli');
  assert.equal(adapterForRosterEntry(S('A', { agent: 'desktop' })), 'claude-cli');
  assert.equal(adapterForRosterEntry(S('A', { agent: 'desktop', session_ref: 'local_x' })), 'claude-desktop');
  assert.equal(adapterForRosterEntry(S('A', { enabled: false })), null);
  const m = rosterToStaff({ staff: [S('NV1', { model: 'm1' }), S('Bad";x'), S('Off', { enabled: false })] });
  assert.deepEqual(Object.keys(m), ['NV1']); assert.equal(m.NV1.model, 'm1');
});

test('khoá máy: env thắng tệp; một dòng; thiếu ⇒ null; khoá quá ngắn ⇒ null', () => {
  const f = join(work, 'machine.key'); writeFileSync(f, 'mk_filekey_abcdefghijklmnop\n');
  assert.equal(loadMachineKey({ env: {}, file: f }).key, 'mk_filekey_abcdefghijklmnop');
  assert.equal(loadMachineKey({ env: { DBIO_MACHINE_KEY: 'mk_envkey_abcdefghijklmnopq' }, file: f }).source, 'env');
  assert.equal(loadMachineKey({ env: {}, file: join(work, 'none') }), null);
  writeFileSync(f, 'short'); assert.equal(loadMachineKey({ env: {}, file: f }), null);
});

test('effectiveStaff: cục bộ > roster > staff_defaults; không adapter ⇒ claude-cli', () => {
  const { config } = normalizeConfig({ staff_defaults: { cwd: '/w', max_context_tokens: 80000 }, staff: { NV1: { cwd: '/x' } } });
  const e = effectiveStaff(config, { NV1: { adapter: 'claude-cli', model: 'm' }, Qa: { adapter: 'claude-desktop', session: 's' } });
  assert.equal(e.NV1.cwd, '/x'); assert.equal(e.NV1.max_context_tokens, 80000); assert.equal(e.Qa.cwd, '/w'); assert.equal(e.Qa.adapter, 'claude-desktop');
  assert.equal(effectiveStaff(config, {}).NV1.adapter, 'claude-cli');
});

test('migrate: TƯƠNG THÍCH NGƯỢC — staff[] giữ nguyên, chỉ thêm staff_defaults; bản N-1 (chỉ đọc staff[]) vẫn thấy adapter+args+cwd; roster rỗng ⇒ không đụng', () => {
  const raw = { staff: { A: { adapter: 'claude-desktop', session: 'local_1', cwd: '/w', args: ['--permission-mode', 'bypassPermissions'] }, B: { adapter: 'claude-desktop', session: 'local_2', cwd: '/w', args: ['--permission-mode', 'bypassPermissions'] }, Z: { adapter: 'codex' } }, discover: { enabled: false } };
  const m = migrateConfig(raw, ['A', 'B']);
  assert.deepEqual(m.dropped, []); assert.deepEqual(Object.keys(m.raw.staff), ['A', 'B', 'Z']);
  assert.deepEqual(m.raw.staff, raw.staff, 'staff[] không đổi một byte');
  assert.deepEqual(m.raw.staff_defaults, { cwd: '/w', args: ['--permission-mode', 'bypassPermissions'] }); assert.equal(m.raw.discover.enabled, true);
  // mô phỏng daemon N-1: chỉ đọc cfg.staff[] (không biết staff_defaults) ⇒ lượt spawn vẫn có bypass
  for (const n of ['A', 'B']) assert.ok(m.raw.staff[n].args.includes('bypassPermissions') && m.raw.staff[n].adapter && m.raw.staff[n].cwd, n);
  assert.deepEqual(migrateConfig(raw, []).raw, raw);
});

function harness({ roster, cache = null, fail = false, key = MK, keyDir = join(work, `keys-${Math.random().toString(36).slice(2)}`) }) {
  const calls = []; const issued = []; const forgot = []; const started = [];
  let cur = roster; let cached = cache; let down = fail;
  const { config } = normalizeConfig({ discover: { enabled: true }, defaults: { coalesce_ms: 0 } });
  const d = createDaemon({
    loadCfg: () => ({ config, errors: [] }), log: process.env.TLOG ? console.log : () => {}, keyDir, machine: 'M',
    makeClient: () => ({ ai: async () => ({}), call: async () => ({}), init: async () => 1, tb: async () => ({}) }),
    stream: (o) => ({ state: { connected: true }, queue: [], done: new Promise(() => {}), stop: () => { started.push(`stop:${o.name}`); } }),
    getAdapter: (a) => ({ name: a, wake: async () => ({ ok: true, detail: 'adapter giả (hermetic)' }) }),
    loadMachineKey: () => key, forgetClient: (n) => forgot.push(n),
    rosterCache: { read: () => cached, write: (r) => { cached = r; } },
    machineCall: async (_mk, _tool, args) => {
      calls.push(args.action);
      if (down) throw new Error('mất mạng');
      if (args.action === 'machine_roster') return cur;
      if (args.action === 'staff_key_issue') { issued.push(args.name); return { key: `sk_${args.name}_abcdefghijklmnopqrstuvwxyz` }; }
      if (args.action === 'worker_beat') return { roster_revision: cur.revision };
      return {};
    },
  });
  return { d, keyDir, calls, issued, forgot, started, set: (r) => { cur = r; }, setDown: (v) => { down = v; }, cache: () => cached };
}

test('roster thêm/bớt: người mới được cấp khoá + bật listener; bị gỡ ⇒ dừng listener + xoá khoá', async () => {
  const h = harness({ roster: { machine_id: 7, revision: 1, staff: [S('NV1'), S('Qa')] } });
  await h.d.load(); await h.d.discover();
  assert.deepEqual([...h.d.streams.keys()].sort(), ['NV1', 'Qa']); assert.deepEqual(h.issued.sort(), ['NV1', 'Qa']);
  assert.ok(existsSync(staffKeyPath('NV1', h.keyDir)));
  assert.match(JSON.parse(readFileSync(staffKeyPath('NV1', h.keyDir), 'utf8')).mcp_url, /x\.test/);
  h.set({ machine_id: 7, revision: 2, staff: [S('NV1'), S('DEV')] });
  await h.d.discover();
  assert.deepEqual([...h.d.streams.keys()].sort(), ['DEV', 'NV1']); assert.ok(h.started.includes('stop:Qa'));
  assert.equal(existsSync(staffKeyPath('Qa', h.keyDir)), false); assert.ok(existsSync(staffKeyPath('DEV', h.keyDir)));
  assert.equal(h.issued.filter((x) => x === 'NV1').length, 1); // có khoá rồi ⇒ không cấp lại
  assert.equal(h.d.writeStatus().roster.revision, 2);
  h.d.stop();
});

test('mất mạng ⇒ dùng cache roster; khởi động offline vẫn nghe đủ; adapter mặc định claude-cli', async () => {
  const h = harness({ roster: { revision: 1, staff: [S('NV1'), S('Qa')] } });
  await h.d.load(); await h.d.discover(); h.d.stop();
  const h2 = harness({ roster: null, fail: true, cache: h.cache(), keyDir: h.keyDir });
  await h2.d.start();
  assert.deepEqual([...h2.d.streams.keys()].sort(), ['NV1', 'Qa']);
  assert.equal(h2.d.streams.get('NV1').entry.adapter, 'claude-cli');
  assert.equal(h2.d.writeStatus().roster.source, 'cache'); assert.ok(h2.d.writeStatus().roster.error);
  h2.d.stop();
});

test('thiếu khoá máy: không chết, không nhân viên, cảnh báo trong status', async () => {
  const h = harness({ roster: null, key: null });
  await h.d.load(); await h.d.discover();
  assert.equal(h.d.streams.size, 0); assert.match(h.d.writeStatus().roster.error, /khoá máy/); assert.equal(h.d.writeStatus().roster.machine_key, false);
  h.d.stop();
});

test('worker_beat bằng khoá máy: revision đổi ⇒ nạp lại roster ngay', async () => {
  const h = harness({ roster: { revision: 1, staff: [S('NV1')] } });
  await h.d.load(); await h.d.discover();
  h.set({ revision: 2, staff: [S('NV1'), S('Qa')] });
  await h.d.workerBeat();
  assert.ok(h.calls.includes('worker_beat')); assert.ok(h.d.streams.has('Qa'));
  h.d.stop();
});

test('roster lỗi tạm thời ⇒ giữ roster cũ, không gỡ ai, không xoá khoá', async () => {
  const h = harness({ roster: { revision: 1, staff: [S('NV1')] } });
  await h.d.load(); await h.d.discover();
  h.setDown(true); await h.d.discover();
  assert.ok(h.d.streams.has('NV1')); assert.ok(existsSync(staffKeyPath('NV1', h.keyDir)));
  h.d.stop();
});

test('khoá máy: khoá trần mượn mcp_url + store_id từ khoá nhân viên; JSON tự mang thì thắng', () => {
  const f = join(work, 'machine2.key'); writeFileSync(f, 'mk_rawkey_abcdefghijklmnop\n');
  const m = loadMachineKey({ env: {}, file: f, fallbackMcp: { mcp_url: 'https://x/mcp', store_id: 7 } });
  assert.equal(m.mcp_url, 'https://x/mcp'); assert.equal(m.store_id, 7);
  assert.equal(loadMachineKey({ env: {}, file: f, fallbackMcp: 'https://y/mcp' }).mcp_url, 'https://y/mcp');
  writeFileSync(f, JSON.stringify({ key: 'mk_jsonkey_abcdefghijklmnop', mcp_url: 'https://j/mcp', store_id: 3 }));
  const j = loadMachineKey({ env: {}, file: f, fallbackMcp: { mcp_url: 'https://x/mcp', store_id: 7 } });
  assert.equal(j.mcp_url, 'https://j/mcp'); assert.equal(j.store_id, 3);
});
