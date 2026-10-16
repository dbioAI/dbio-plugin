import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, createExtractor, createRunLog, redact, runEventsEnabled } from '../lib/agentd/runlog.mjs';
import { parseRunOutput } from '../lib/agentd/runs.mjs';
import { outputArgs } from '../lib/agentd/adapters/util.mjs';

const tu = (id, name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const tr = (id, content, is_error = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv';

test('classifyCommand: kind theo lệnh, chỉ dòng đầu, ≤80 ký tự', () => {
  assert.equal(classifyCommand('node --test test/a.test.mjs').kind, 'test');
  assert.equal(classifyCommand('npm run build:dash').kind, 'build');
  assert.equal(classifyCommand('bash scripts/deploy-worker.sh p4').kind, 'deploy');
  assert.equal(classifyCommand('sleep 60').kind, 'wait');
  assert.equal(classifyCommand('git status').kind, 'cmd');
  const c = classifyCommand(`cat <<EOF\nNỘI DUNG TỆP BÍ MẬT\nEOF`); assert.ok(!/BÍ MẬT/.test(c.text));
  assert.ok(classifyCommand('echo ' + 'x'.repeat(300)).text.length <= 80);
});

test('redact: không lọt khoá/token', () => {
  for (const s of [`curl -H "Authorization: Bearer ${KEY}"`, `export API_KEY=${KEY}`, `dbio --token abcdef123456 x`, `echo ${'a1'.repeat(24)}`, `password=hunter2hunter2`]) {
    const r = classifyCommand(s).text; assert.ok(!/AbCdEf|abcdef123456|hunter2|a1a1a1a1a1/.test(r), r);
  }
  assert.equal(redact('hello'), 'hello');
});

test('extractor: ≥5 bước đúng kind + test pass/fail + deploy + tóm tắt', () => {
  const ex = createExtractor(); const out = [];
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    tu('1', 'Bash', { command: 'git log -1' }), tr('1', 'abc'),
    tu('2', 'Edit', { file_path: 'D:/x/lib/a.mjs', old_string: 'SECRET-BODY', new_string: 'y' }), tr('2', 'ok'),
    tu('3', 'Write', { file_path: 'D:/x/lib/b.mjs', content: KEY }), tr('3', 'ok'),
    tu('4', 'Bash', { command: 'node --test test/' }), tr('4', '# pass 12\n# fail 0'),
    tu('5', 'Bash', { command: 'npm test' }), tr('5', '# pass 3\n# fail 2'),
    tu('6', 'mcp__claude_ai_DBIO__invoke', { action: 'task_board', secret: KEY }), tr('6', 'x'),
    tu('7', 'Bash', { command: 'wrangler deploy' }), tr('7', 'Deployed. Version ID: 1a2b3c4d-1111-2222-3333-444455556666'),
    tu('8', 'Bash', { command: 'sleep 30' }), tr('8', ''),
    tu('9', 'Read', { file_path: 'x' }), tr('9', 'file body'),
  ];
  for (const l of lines) out.push(...ex.feed(l));
  const kinds = out.map((s) => s.kind);
  for (const k of ['cmd', 'edit', 'test', 'deploy', 'mcp', 'wait', 'note']) assert.ok(kinds.includes(k), k);
  assert.ok(out.length >= 5);
  const all = JSON.stringify(out); assert.ok(!all.includes('SECRET-BODY') && !all.includes('AbCdEf') && !all.includes('file body'));
  assert.ok(out.some((s) => s.text === 'test pass') && out.some((s) => s.text === 'test FAIL'));
  assert.match(ex.summary(), /2 tệp sửa/); assert.match(ex.summary(), /test 1 pass\/1 fail/); assert.match(ex.summary(), /deploy 1a2b3c4d/);
});

test('createRunLog: lô theo nhịp, thử lại khi lỗi, trần sự kiện, end đẩy nốt', async () => {
  let tick = null; const sent = []; let fail = true;
  const rl = createRunLog({ runId: 'r1', maxEvents: 3, setTimer: (f) => { tick = f; return {}; }, clearTimer() {}, send: async (b) => { if (fail) throw new Error('503'); sent.push(...b); } });
  for (let i = 0; i < 5; i++) rl.feedLine(tu(String(i), 'Bash', { command: `echo ${i}` }));
  await tick(); assert.equal(sent.length, 0); fail = false;
  await tick(); assert.equal(sent.length, 4); // 3 bước + 1 dòng trần
  assert.ok(sent.every((e) => e.run_id === 'r1' && typeof e.at === 'number'));
  assert.match(sent[3].text, /trần 3/);
  const s = await rl.end(); assert.match(s, /5 lệnh/);
});

test('cờ tắt + tham số CLI + parse kết quả stream-json', () => {
  assert.equal(runEventsEnabled({}, {}, {}), true);
  assert.equal(runEventsEnabled({ run_events: false }, {}, {}), false);
  assert.equal(runEventsEnabled({}, { defaults: { run_events: false } }, {}), false);
  assert.equal(runEventsEnabled({}, {}, { DBIO_AGENTD_RUN_EVENTS: '0' }), false);
  assert.deepEqual(outputArgs({}), ['--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(outputArgs({ run_events: false }), ['--output-format', 'json']);
  const out = [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }), tu('1', 'Bash', { command: 'ls' }), JSON.stringify({ type: 'result', is_error: false, session_id: 's1', num_turns: 2, modelUsage: { m: { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 9, cacheCreationInputTokens: 1, costUSD: 0.1 } } })].join('\n');
  const u = parseRunOutput(out); assert.equal(u.session_id, 's1'); assert.equal(u.tokens.output, 7); assert.equal(u.is_error, false);
});
