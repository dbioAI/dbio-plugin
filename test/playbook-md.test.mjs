import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forUpdate, mdToPlaybook, splitMd, summarize, syncPlaybook } from '../lib/playbook-md.mjs';

// 8 tiêu đề của playbook-ai-staff-chat (profile 168002): 7 mục nạp tay 1/10 (#648) + "Điều kiện làm việc" (hợp nhất kho ← .claude, #756)
const ONLINE_TITLES = ['Phạm vi (làm gì / không đụng gì)', 'Bản đồ mã', 'Dữ liệu & id quan trọng', 'Luật & bẫy', 'Kiểm tra & deploy', 'Skill dùng kèm', 'Điều kiện làm việc', 'Nhật ký học'];

test('splitMd: tách ## thành mục, bỏ # H1, giữ ### con, không tách trong khối ```', () => {
  const r = splitMd('# Tên\n\nMở đầu\n\n## A\nthân a\n### con\nx\n```\n## không phải mục\n```\n\n## B\nthân b\n');
  assert.equal(r.h1, 'Tên');
  assert.equal(r.intro, 'Mở đầu');
  assert.deepEqual(r.sections.map((s) => s.title), ['A', 'B']);
  assert.match(r.sections[0].body, /### con/);
  assert.match(r.sections[0].body, /## không phải mục/);
});

test('mdToPlaybook: hình dạng entry giống bản online (id e<i>/g<i>, label, detail, x)', () => {
  const pb = mdToPlaybook('# ai-staff-chat\n\n## Bản đồ mã\n- a\n\n## Luật & bẫy\n- b\n', 'ai-staff-chat', { today: '2026-10-03' });
  assert.deepEqual(pb.meta, { id: 'playbook-ai-staff-chat', kind: 'knowledge', title: 'Playbook nhân viên AI · ai-staff-chat', summary: pb.meta.summary, authority: 'source', status: 'draft', tags: ['staff-playbook', 'ai-staff-chat'], author: {}, revision: 1 });
  assert.deepEqual(pb.groups, [{ id: 'g1', title: 'Bản đồ mã' }, { id: 'g2', title: 'Luật & bẫy' }]);
  assert.equal(pb.nodes.length, 2);
  assert.deepEqual(Object.keys(pb.nodes[0]), ['id', 'type', 'group', 'label', 'detail', 'x']);
  assert.equal(pb.nodes[1].id, 'e2'); assert.equal(pb.nodes[1].group, 'g2'); assert.equal(pb.nodes[1].type, 'entry');
  assert.equal(pb.nodes[0].detail, '- a');
  assert.equal(pb.nodes[0].x.verified_at, '2026-10-03');
  assert.ok(pb.nodes[0].x.asks.length >= 1 && pb.nodes[0].x.when);
  assert.equal(pb.edges, undefined, 'knowledge không có edges');
});

test('mdToPlaybook: phần đầu tệp có chữ ⇒ mục đầu "Tổng quan"; mục rỗng bị bỏ; không có mục ⇒ lỗi', () => {
  const pb = mdToPlaybook('# VAI X — playbook (3/10)\n\nModel: Sonnet.\n\n## Rỗng\n\n## Có\nnội dung\n', 'vai-x');
  assert.deepEqual(pb.nodes.map((n) => n.label), ['Tổng quan', 'Có']);
  assert.equal(pb.meta.title, 'Playbook nhân viên AI · VAI X');
  assert.throws(() => mdToPlaybook('# chỉ tiêu đề\n', 'x'), /không có mục/);
  assert.throws(() => mdToPlaybook('## A\nb', ''), /slug/);
});

test('ai-staff-chat.md → ĐÚNG 8 mục, cùng tiêu đề với bản online', (t) => {
  const f = join(fileURLToPath(import.meta.url), '..', '..', 'playbooks', 'ai-staff-chat.md');
  if (!existsSync(f)) return t.skip('thiếu playbooks/ai-staff-chat.md');
  const pb = mdToPlaybook(readFileSync(f, 'utf8'), 'ai-staff-chat');
  assert.deepEqual(pb.nodes.map((n) => n.label), ONLINE_TITLES);
  assert.equal(pb.nodes.length, 8);
  assert.equal(summarize(pb).entries, 8);
});

test('forUpdate: giữ status/authority/revision hiện có của bản online', () => {
  const pb = mdToPlaybook('## A\nb', 'x');
  const u = forUpdate(pb, { status: 'published', revision: 4, authority: 'derived' });
  assert.equal(u.meta.status, 'published'); assert.equal(u.meta.revision, 4); assert.equal(u.meta.authority, 'derived');
  assert.equal(forUpdate(pb, {}).meta.status, 'draft');
});

test('syncPlaybook: chưa có ⇒ create {slug, playbook}', async () => {
  const calls = [];
  const call = async (a) => { calls.push(a); return a.action === 'list' ? { playbooks: [{ slug: 'playbook-khac', profile_id: 1 }] } : { profile_id: 777 }; };
  const pb = mdToPlaybook('## A\nb', 'x');
  const r = await syncPlaybook(call, pb);
  assert.deepEqual(r, { action: 'created', profile_id: 777, entries: 1 });
  assert.deepEqual(calls.map((c) => c.action), ['list', 'create']);
  assert.equal(calls[1].slug, 'playbook-x');
});

test('syncPlaybook: đã có ⇒ get lấy digest rồi save kèm base_digest (không create)', async () => {
  const calls = [];
  const call = async (a) => {
    calls.push(a);
    if (a.action === 'list') return { playbooks: [{ slug: 'playbook-x', profile_id: 55 }] };
    if (a.action === 'get') return { digest: 'sha256:abc', playbook: { meta: { status: 'draft', revision: 2 } } };
    return { success: true };
  };
  const r = await syncPlaybook(call, mdToPlaybook('## A\nb', 'x'));
  assert.deepEqual(r, { action: 'updated', profile_id: 55, entries: 1 });
  assert.deepEqual(calls.map((c) => c.action), ['list', 'get', 'save']);
  assert.equal(calls[2].base_digest, 'sha256:abc'); assert.equal(calls[2].profile_id, 55);
  assert.equal(calls[2].playbook.meta.revision, 2);
});

test('syncPlaybook: get không có digest ⇒ từ chối lưu mù', async () => {
  const call = async (a) => (a.action === 'list' ? { playbooks: [{ slug: 'playbook-x', profile_id: 5 }] } : { playbook: {} });
  await assert.rejects(() => syncPlaybook(call, mdToPlaybook('## A\nb', 'x')), /digest/);
});

// ---- #756: cảnh báo ghi đè bản online lớn hơn
import { overwriteWarnings, fmtWarning } from '../lib/playbook-md.mjs';
const pbOf = (...pairs) => ({ nodes: pairs.map(([label, detail]) => ({ label, detail })) });

test('overwriteWarnings: mục online lớn hơn mục sắp đẩy quá dung sai ⇒ bigger; trong dung sai ⇒ im', () => {
  const online = pbOf(['Nhật ký học', 'x'.repeat(1000)], ['Luật & bẫy', 'y'.repeat(100)]);
  const next = pbOf(['Nhật ký học', 'x'.repeat(30)], ['Luật & bẫy', 'y'.repeat(90)]); // 100 vs 90: trong 16B
  const w = overwriteWarnings(online, next);
  assert.deepEqual(w, [{ kind: 'bigger', label: 'Nhật ký học', online: 1000, next: 30 }]);
});

test('overwriteWarnings: mục online không còn trong bản sắp đẩy ⇒ missing; khớp tiêu đề bỏ phần trong ngoặc + hoa thường', () => {
  const online = pbOf(['Điều kiện làm việc', 'abc'], ['3. Sổ cái (bảng hệ thống của nhóm)', 'abc']);
  const next = pbOf(['3. sổ cái', 'abc']);
  assert.deepEqual(overwriteWarnings(online, next), [{ kind: 'missing', label: 'Điều kiện làm việc', online: 3, next: 0 }]);
});

test('overwriteWarnings: đếm byte UTF-8 (tiếng Việt), bản mới lớn hơn/bằng ⇒ không cảnh báo; thiếu dữ liệu ⇒ []', () => {
  assert.deepEqual(overwriteWarnings(pbOf(['A', 'ắ'.repeat(10)]), pbOf(['A', 'ắ'.repeat(10)])), []);
  assert.deepEqual(overwriteWarnings(pbOf(['A', 'a']), pbOf(['A', 'a'.repeat(500)])), []);
  assert.deepEqual(overwriteWarnings(undefined, pbOf(['A', 'a'])), []);
  assert.deepEqual(overwriteWarnings({ meta: {} }, undefined), []);
  assert.match(fmtWarning({ kind: 'bigger', label: 'L', online: 9, next: 1 }), /online 9B > sắp đẩy 1B/);
  assert.match(fmtWarning({ kind: 'missing', label: 'L', online: 9, next: 0 }), /KHÔNG có trong bản sắp đẩy/);
});

test('syncPlaybook: có cảnh báo ghi đè và không force ⇒ blocked, KHÔNG save; --force ⇒ save + trả warnings', async () => {
  const mk = () => { const calls = []; const call = async (a) => {
    calls.push(a);
    if (a.action === 'list') return { playbooks: [{ slug: 'playbook-x', profile_id: 55 }] };
    if (a.action === 'get') return { digest: 'sha256:abc', playbook: { meta: { status: 'draft', revision: 2 }, nodes: [{ label: 'A', detail: 'z'.repeat(400) }] } };
    return { success: true };
  }; return { calls, call }; };
  const pb = mdToPlaybook('## A\nb', 'x');
  const a = mk(); const r1 = await syncPlaybook(a.call, pb);
  assert.equal(r1.action, 'blocked'); assert.equal(r1.warnings[0].kind, 'bigger');
  assert.deepEqual(a.calls.map((c) => c.action), ['list', 'get']);
  const b = mk(); const r2 = await syncPlaybook(b.call, pb, { force: true });
  assert.equal(r2.action, 'updated'); assert.equal(r2.warnings.length, 1);
  assert.deepEqual(b.calls.map((c) => c.action), ['list', 'get', 'save']);
});

test('mdToPlaybook: store_id tác giả chỉ có khi truyền storeId (không mặc định số nội bộ)', () => {
  assert.deepEqual(mdToPlaybook('# A — playbook\n\n## M\nx\n', 'a').meta.author, {});
  assert.deepEqual(mdToPlaybook('# A — playbook\n\n## M\nx\n', 'a', { storeId: 5 }).meta.author, { store_id: 5 });
});
