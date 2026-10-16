import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeNamed, evictSameScript, reconcileProcs, sameScriptDaemons } from '../lib/agentd/procs.mjs';

const SCRIPT = 'D:\\2026\\dbioAI\\dbio-plugin\\bin\\dbio-agentd.mjs';
const procs = [
  { pid: 10, cmd: `"C:\\node.exe" ${SCRIPT} run` },
  { pid: 11, cmd: '"C:\\node.exe" D:\\other\\dbio-agentd.mjs run' },
  { pid: 12, cmd: `"C:\\node.exe" ${SCRIPT} status` },
  { pid: 13, cmd: `"C:\\node.exe" ${SCRIPT.replace(/\\/g, '/')} run` },
  { pid: 99, cmd: `"C:\\node.exe" ${SCRIPT} run` },
  { pid: 20, cmd: 'C:\\x\\claude.exe -p --output-format stream-json --name NV1 --model m' },
  { pid: 21, cmd: 'claude -p --name NV2' },
  { pid: 22, cmd: 'claude --name NV3 --resume abc' }, // phiên tương tác (không -p)
  { pid: 23, cmd: 'node D:\\x\\claude-helper.js --name x -p' },
];

test('#1060 (2): chỉ khớp daemon CÙNG script `run`, trừ chính mình; script khác/lệnh status không đụng', () => {
  assert.deepEqual(sameScriptDaemons(procs, SCRIPT, 99).map((p) => p.pid), [10, 13]);
});

test('#1060 (2): daemon mới giết daemon cũ cùng script rồi chờ chết; kẹt ⇒ SIGKILL sau graceMs', async () => {
  const dead = new Set(); const sent = [];
  const alive = (p) => !dead.has(p);
  const r1 = await evictSameScript({ script: SCRIPT, self: 99, list: async () => procs, alive, kill: (p, s) => { sent.push([p, s]); dead.add(p); }, sleep: async () => {} });
  assert.deepEqual(r1, { killed: [10, 13], stuck: [] }); assert.deepEqual(sent, [[10, 'SIGTERM'], [13, 'SIGTERM']]);
  const sent2 = []; const stuckPids = new Set([10]);
  const r2 = await evictSameScript({ script: SCRIPT, self: 99, list: async () => procs.slice(0, 1), alive: (p) => stuckPids.has(p), kill: (p, s) => { sent2.push(s); if (s === 'SIGKILL') stuckPids.delete(p); }, sleep: async () => {}, graceMs: 1000 });
  assert.deepEqual(sent2, ['SIGTERM', 'SIGKILL']); assert.deepEqual(r2, { killed: [10], stuck: [] });
  const r3 = await evictSameScript({ script: SCRIPT, self: 99, list: async () => [], alive });
  assert.deepEqual(r3, { killed: [], stuck: [] });
});

test('#1060 (3): chỉ đếm `claude … -p … --name`; so với Run mở còn sống; lệch ⇒ mismatch + pid lạ', () => {
  assert.deepEqual(claudeNamed(procs).map((p) => p.pid), [20, 21]);
  const ok = reconcileProcs(procs, [{ pid: 20 }, { pid: 21 }], () => true);
  assert.deepEqual({ n: ok.named, o: ok.open, m: ok.mismatch, e: ok.extra }, { n: 2, o: 2, m: false, e: [] });
  const bad = reconcileProcs(procs, [{ pid: 20 }, { pid: 77 }], (p) => p === 20);
  assert.deepEqual({ n: bad.named, o: bad.open, m: bad.mismatch, e: bad.extra }, { n: 2, o: 1, m: true, e: [21] });
  assert.equal(reconcileProcs([], [], () => true).mismatch, false);
});
