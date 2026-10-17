import './helpers/hermetic.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendRecord, collectAndSend, collectGit, planEvidence, presetOf, readRecords, summarize, weakeningLines } from '../lib/evidence.mjs';
import { baseSha, turnEndEvidence } from '../lib/agentd/evidence-turn.mjs';

process.env.DBIO_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'ev-state-'));
const sh = (d, ...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
/** repo gốc (origin) + bản clone; main có 1 commit (a.txt, a.test.mjs). */
function fixture() {
  const origin = mkdtempSync(join(tmpdir(), 'ev-origin-')); sh(origin, 'init', '-q'); sh(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');   // git 2.7: không có init -b
  writeFileSync(join(origin, 'a.txt'), '1\n'); writeFileSync(join(origin, 'a.test.mjs'), 'it("x", () => {})\n');
  sh(origin, 'add', '-A'); sh(origin, 'commit', '-qm', 'init');
  const w = mkdtempSync(join(tmpdir(), 'ev-work-')); execFileSync('git', ['clone', '-q', origin, w]);
  return { origin, w };
}

test('weakeningLines: chỉ dòng + làm yếu test', () => {
  const d = '+++ b/x\n+  it.skip("a")\n+ normal\n-  it.skip("old")\n+ jest --passWithNoTests\n+  xit("b")';
  assert.deepEqual(weakeningLines(d), ['it.skip("a")', 'jest --passWithNoTests', 'xit("b")']);
  assert.deepEqual(weakeningLines(''), []);
});

test('presetOf: build:dash > unit > build; lạ ⇒ null', () => {
  assert.equal(presetOf('npm run build:dash'), 'build:dash');
  assert.equal(presetOf('npm test -- x'), 'unit');
  assert.equal(presetOf('node --test test/*.mjs'), 'unit');
  assert.equal(presetOf('npx tsc -p .'), 'build');
  assert.equal(presetOf('echo hi'), null);
});

test('collectGit: nhánh có commit ⇒ head/base/files/deleted/added_lines; on_main=false; sau merge on_main=true', () => {
  const { w } = fixture();
  assert.equal(collectGit(join(tmpdir(), 'khong-co-repo-' + Date.now())), null);
  const main = sh(w, 'rev-parse', 'HEAD');
  sh(w, 'checkout', '-qb', 'feat'); writeFileSync(join(w, 'b.txt'), 'new\n'); sh(w, 'add', '-A'); sh(w, 'commit', '-qm', 'b');
  sh(w, 'rm', '-q', 'a.test.mjs'); writeFileSync(join(w, 'c.test.mjs'), 'it.skip("y")\n'); sh(w, 'add', '-A'); sh(w, 'commit', '-qm', 'c');
  const f = collectGit(w);
  assert.equal(f.base, main); assert.equal(f.head, sh(w, 'rev-parse', 'HEAD')); assert.equal(f.branch, 'feat');
  assert.deepEqual(f.files.sort(), ['a.test.mjs', 'b.txt', 'c.test.mjs']); assert.deepEqual(f.deleted, ['a.test.mjs']);
  assert.deepEqual(f.added_lines, ['it.skip("y")']); assert.equal(f.on_main, false);
  sh(w, 'checkout', '-q', 'main'); sh(w, 'merge', '-q', '--ff-only', 'feat'); sh(w, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(collectGit(w).on_main, true);
});

test('planEvidence: thứ tự base → repo_sha → scope_diff → record → deploy; chỉ bản ghi đúng HEAD; không gửi lại', () => {
  const head = 'a'.repeat(40); const facts = { head, base: 'b'.repeat(40), branch: 'feat', on_main: false, files: ['x'], deleted: [], added_lines: [] };
  const records = [{ preset: 'unit', exit: 0, sha: 'c'.repeat(40), at: '1' }, { preset: 'unit', exit: 1, sha: head, at: '2' }, { preset: 'unit', exit: 0, sha: head, at: '3', cmd: 'npm test' }, { preset: 'build', exit: 0, sha: head, at: '4' }];
  const p = planEvidence({ facts, records, attemptBase: 'b'.repeat(40), author: 'NV1', runId: 'r1', deploy: { version: 'v9' } });
  assert.deepEqual(p.map((x) => x.args.kind), ['attempt_base', 'repo_sha', 'scope_diff', 'record', 'record', 'deploy']);
  const rec = p.filter((x) => x.args.kind === 'record').map((x) => x.args.payload);
  assert.deepEqual(rec.map((x) => [x.preset, x.exit]), [['unit', 0], ['build', 0]]);   // bản ghi MỚI NHẤT mỗi preset, bỏ bản trên sha khác
  assert.equal(rec[0].run_id, 'r1');
  assert.deepEqual(p[5].args.payload, { source: 'cli_live', version: 'v9', sha: head });
  const again = planEvidence({ facts, records, attemptBase: 'b'.repeat(40), deploy: { version: 'v9' }, sent: new Set(p.map((x) => x.k)) });
  assert.equal(again.length, 0);
  assert.equal(planEvidence({ facts: null }).length, 0);
});

test('collectAndSend: gửi theo thứ tự, ghi nhớ đã gửi (lần 2 chỉ bước lỗi), lỗi một bước không ghi nhớ bước đó', async () => {
  const { w } = fixture(); sh(w, 'checkout', '-qb', 'feat'); writeFileSync(join(w, 'z.txt'), 'z'); sh(w, 'add', '-A'); sh(w, 'commit', '-qm', 'z');
  const head = sh(w, 'rev-parse', 'HEAD');
  appendRecord(7, 11, { preset: 'unit', cmd: 'npm test', exit: 0, sha: head });
  assert.equal(readRecords(7, 11).length, 1);
  const calls = []; const call = async (a) => { calls.push(a); if (a.kind === 'record') throw new Error('mạng'); };
  const r1 = await collectAndSend({ board: 7, card: 11, dir: w, call, attemptBase: 'f'.repeat(40), author: 'NV1' });
  assert.deepEqual(calls.map((c) => c.kind), ['attempt_base', 'repo_sha', 'scope_diff', 'record']);
  assert.deepEqual(r1.failed.map((x) => x.kind), ['record']);
  assert.ok(calls.every((c) => c.profile_id === 7 && c.task_id === 11));
  assert.deepEqual(calls[2].files, ['z.txt']); assert.match(summarize(r1), /lỗi record: mạng/);
  const calls2 = []; const r2 = await collectAndSend({ board: 7, card: 11, dir: w, call: async (a) => { calls2.push(a.kind); }, attemptBase: 'f'.repeat(40) });
  assert.deepEqual(calls2, ['record']); assert.deepEqual(r2.sent, ['record']);
  const r3 = await collectAndSend({ board: 7, card: 11, dir: w, call: async () => { throw new Error('không được gọi'); }, attemptBase: 'f'.repeat(40) });
  assert.deepEqual(r3.sent, []); assert.match(summarize(r3), /đã đủ/);
});

test('collectAndSend: không khoá máy / không git ⇒ bỏ qua, không ném; khoá bị từ chối ⇒ dừng sớm', async () => {
  assert.equal((await collectAndSend({ board: 1, card: 2, dir: tmpdir(), call: null })).skipped, 'no_machine_key');
  assert.match(summarize({ skipped: 'no_machine_key' }), /khoá máy/);
  assert.equal((await collectAndSend({ board: 1, card: 2, dir: join(tmpdir(), 'khong-repo-' + Date.now()), call: async () => {} })).skipped, 'no_git');
  const { w } = fixture(); let n = 0;
  const r = await collectAndSend({ board: 1, card: 3, dir: w, call: async () => { n++; const e = new Error('401'); e.auth = true; throw e; } });
  assert.equal(n, 1); assert.equal(r.failed.length, 1);
});

test('turnEndEvidence: gửi bằng khoá máy (action evidence_add), vá work_state {run_id, attempt_base} giữ trường cũ; thẻ lạ ⇒ skipped', async () => {
  const { w } = fixture(); const start = baseSha(w); assert.match(start, /^[0-9a-f]{40}$/);
  sh(w, 'checkout', '-qb', 'feat'); writeFileSync(join(w, 'q.txt'), 'q'); sh(w, 'add', '-A'); sh(w, 'commit', '-qm', 'q');
  const mcalls = []; const tbs = [];
  const client = { init: async () => {}, tb: async (a, args) => { tbs.push([a, args]); return a === 'task_get' ? { task: { work_state: { next: 'x', blocked: null, at: 'T', by: 'NV1' } } } : {}; } };
  const r = await turnEndEvidence({ run: { run_id: 'run-1', card: '9#21', base_sha: start }, name: 'NV1', cwd: w, mk: { key: 'k'.repeat(20), mcp_url: 'u' }, client, mcall: async (mk, tool, args) => { mcalls.push([tool, args]); return {}; } });
  assert.deepEqual(r.sent, ['attempt_base', 'repo_sha', 'scope_diff']); assert.equal(r.patched, true);
  assert.ok(mcalls.every(([t, a]) => t === 'task_board' && a.action === 'evidence_add' && a.profile_id === 9 && a.task_id === 21));
  assert.equal(mcalls[0][1].payload.author, 'NV1');
  const cp = tbs.find(([a]) => a === 'checkpoint')[1];
  assert.equal(cp.task_id, 21); assert.equal(cp.work_state.run_id, 'run-1'); assert.equal(cp.work_state.attempt_base, start); assert.equal(cp.work_state.next, 'x'); assert.equal('at' in cp.work_state, false);
  assert.equal((await turnEndEvidence({ run: { run_id: 'r', card: null }, name: 'NV1', cwd: w, mk: null })).skipped, 'no_card');
  const nokey = await turnEndEvidence({ run: { run_id: 'r2', card: '9#22' }, name: 'NV1', cwd: w, mk: null, client: null });
  assert.equal(nokey.skipped, 'no_machine_key');
});

test('collectGit: commit thẳng lên main — có attempt_base (tổ tiên) ⇒ diff base..head khác rỗng; hint rác ⇒ rơi về merge-base', () => {
  const { w } = fixture(); const start = sh(w, 'rev-parse', 'HEAD');
  writeFileSync(join(w, 'm.txt'), 'm'); sh(w, 'add', '-A'); sh(w, 'commit', '-qm', 'm'); sh(w, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.deepEqual(collectGit(w).files, []);   // không hint: merge-base = HEAD ⇒ rỗng
  const f = collectGit(w, undefined, undefined, start);
  assert.equal(f.base, start); assert.deepEqual(f.files, ['m.txt']); assert.equal(f.on_main, true);
  assert.deepEqual(collectGit(w, undefined, undefined, 'zzzzzzz').files, []);
  assert.deepEqual(collectGit(w, undefined, undefined, 'f'.repeat(40)).files, []);   // sha không tồn tại
});
