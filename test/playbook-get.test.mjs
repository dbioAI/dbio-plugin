import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bodyFromText, getPlaybook, pickSections, probeAiPlaybook, reasonOf, renderLocal } from '../lib/playbook-get.mjs';

const OUTLINE = { digest: 'sha256:abcdef0123456789aa', groups: [{ id: 'g1', title: 'Tổng quan' }, { id: 'g2', title: '6. Luật cứng' }], nodes: [{ label: 'Tổng quan', group: 'g1' }, { label: '6. Luật cứng', group: 'g2' }] };
const TEXT = (g) => ({ digest: OUTLINE.digest, text: g ? `# Tiêu đề\nTóm tắt\n\n## 6. Luật cứng\n- không in khoá` : '# Tiêu đề\n\n## Tổng quan\n- a\n\n## 6. Luật cứng\n- không in khoá' });
const calls = [];
const api = () => ({ outline: async (s) => { calls.push(['outline', s]); return OUTLINE; }, text: async (s, g) => { calls.push(['text', s, g]); return TEXT(g); } });
const LOCAL = '# X\n\nintro\n\n## Phạm vi\n- a\n\n## Luật cứng\n- b\n';
const deps = (o = {}) => ({ keyStatus: () => 'ok', api, readLocalText: () => LOCAL, ...o });

test('online: dàn ý dùng get KHÔNG view, dòng đầu ghi (online), không tải nội dung', async () => {
  calls.length = 0;
  const r = await getPlaybook('sample-pb', {}, deps());
  assert.equal(r.source, 'online'); assert.equal(r.code, 0); assert.equal(r.warning, undefined);
  assert.match(r.lines[0], /^\(online\) sample-pb — 2 mục/); assert.deepEqual(calls, [['outline', 'playbook-sample-pb']]);
  assert.ok(r.lines.includes('  ## 6. Luật cứng'));
});
test('online: --section khớp nhãn không phân biệt hoa thường, gọi view text với id nhóm, chỉ in mục đó', async () => {
  calls.length = 0;
  const r = await getPlaybook('sample-pb', { section: 'luật CỨNG' }, deps());
  assert.deepEqual(calls[1], ['text', 'playbook-sample-pb', 'g2']);
  assert.equal(r.lines[1], '## 6. Luật cứng\n- không in khoá'); assert.match(r.lines[0], /^\(online\)/);
});
test('online: --section không có mục ⇒ lỗi người dùng (code 1), KHÔNG rơi về kho', async () => {
  const r = await getPlaybook('x', { section: 'zzz' }, deps());
  assert.equal(r.code, 1); assert.equal(r.source, 'online'); assert.match(r.lines[0], /Không có mục chứa "zzz"/);
});
test('online: --full dùng view text không section', async () => {
  calls.length = 0;
  const r = await getPlaybook('x', { full: true }, deps());
  assert.deepEqual(calls, [['text', 'playbook-x', undefined]]); assert.match(r.lines[1], /Tổng quan/);
});
test('thiếu khoá ⇒ kho + cảnh báo nêu lý do, không gọi mạng', async () => {
  calls.length = 0;
  const r = await getPlaybook('x', {}, deps({ keyStatus: () => 'missing' }));
  assert.equal(r.source, 'local'); assert.equal(r.code, 0); assert.deepEqual(calls, []);
  assert.match(r.warning, /^⚠️ đọc bản KHO \(dự phòng\): không có khoá/); assert.match(r.lines[0], /^x — \d+ dòng · 2 mục/);
});
test('lỗi mạng / khoá bị từ chối / ai_playbook từ chối ⇒ kho + cảnh báo đúng lý do', async () => {
  const bad = (e) => deps({ api: () => ({ outline: async () => { throw e; }, text: async () => { throw e; } }) });
  assert.match((await getPlaybook('x', {}, bad(new Error('fetch failed')))).warning, /lỗi mạng/);
  assert.match((await getPlaybook('x', {}, bad(Object.assign(new Error('Khoá bị từ chối (HTTP 403)'), { auth: true })))).warning, /khoá bị từ chối \(thiếu scope/);
  const forb = Object.assign(new Error('từ chối: no'), { code: 'department_forbidden' });
  assert.match((await getPlaybook('x', {}, bad(forb))).warning, /ai_playbook từ chối \(department_forbidden\)/);
});
test('--local ép kho, không cảnh báo, không đụng khoá/mạng', async () => {
  const r = await getPlaybook('x', { section: 'phạm vi' }, deps({ keyStatus: () => { throw new Error('không được gọi'); } }), 'local');
  assert.equal(r.source, 'local'); assert.equal(r.warning, undefined); assert.match(r.lines[0], /## Phạm vi/);
});
test('--online: hỏng ⇒ code 1, KHÔNG rơi về kho', async () => {
  const r = await getPlaybook('x', {}, deps({ keyStatus: () => 'broken' }), 'online');
  assert.equal(r.code, 1); assert.equal(r.source, 'online'); assert.match(r.lines[0], /tệp khoá hỏng/);
  const r2 = await getPlaybook('x', {}, deps({ api: () => ({ outline: async () => { throw new Error('fetch failed'); } }) }), 'online');
  assert.equal(r2.code, 1);
});
test('kho cũng không có ⇒ code 1 kèm cảnh báo', async () => {
  const r = await getPlaybook('x', {}, deps({ keyStatus: () => 'missing', readLocalText: () => { throw new Error('Không có playbook "x"'); } }));
  assert.equal(r.code, 1); assert.ok(r.warning);
});
test('renderLocal: full / section / dàn ý + lỗi từ khoá', () => {
  assert.equal(renderLocal(LOCAL, 'x', { full: true })[0], LOCAL.trimEnd());
  assert.match(renderLocal(LOCAL, 'x', { section: 'luật' })[0], /^## Luật cứng/);
  assert.throws(() => renderLocal(LOCAL, 'x', { section: 'q' }), /Mục: Phạm vi \| Luật cứng/);
});
test('pickSections / bodyFromText', () => {
  assert.deepEqual(pickSections(OUTLINE, 'luật'), [{ label: '6. Luật cứng', group: 'g2' }]);
  assert.equal(bodyFromText('# T\nsum\n\n## A\nb'), '## A\nb'); assert.equal(bodyFromText('## A\nb'), '## A\nb');
});
test('probeAiPlaybook: ok / thiếu khoá (không gọi) / lỗi', async () => {
  let n = 0; const ok = async () => { n++; return {}; };
  assert.deepEqual(await probeAiPlaybook('ok', ok), { ok: true }); assert.equal(n, 1);
  assert.match((await probeAiPlaybook('missing', ok)).reason, /không có khoá/); assert.equal(n, 1);
  assert.match((await probeAiPlaybook('ok', async () => { throw new Error('HTTP 502'); })).reason, /lỗi mạng/);
});
test('reasonOf mặc định', () => { assert.equal(reasonOf(new Error('abc')), 'abc'); assert.equal(reasonOf(null, 'ok'), 'lỗi không rõ'); });
