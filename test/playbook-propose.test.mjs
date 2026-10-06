import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyToMd, buildProposal, openProposals, parseProposal, sectionTitles } from '../lib/playbook-propose.mjs';

const MD = '# X — playbook\n\nMở đầu\n\n## A\n\nthân a\n```\n## không phải mục\n```\n\n## B\n\nthân b\n\n## Nhật ký học\n\n- cũ\n';

test('buildProposal ↔ parseProposal khứ hồi; góp ý thường ⇒ null', () => {
  const b = buildProposal({ mode: 'add', text: ' dòng\nhai ', card: '#822', by: 'DEV' });
  assert.equal(b.split('\n')[0], '[ĐỀ XUẤT thêm] thẻ #822 · bởi DEV');
  assert.deepEqual(parseProposal(b), { mode: 'add', text: 'dòng\nhai', meta: 'thẻ #822 · bởi DEV' });
  assert.equal(parseProposal(buildProposal({ mode: 'replace', text: 'x' })).mode, 'replace');
  assert.equal(parseProposal('chỉ là góp ý'), null);
  assert.equal(parseProposal('[ĐỀ XUẤT thêm]\n'), null);
  assert.throws(() => buildProposal({ mode: 'add', text: '  ' }));
  assert.throws(() => buildProposal({ mode: 'x', text: 'a' }));
});

test('applyToMd add: nối cuối đúng mục, mục khác nguyên byte, danh sách mục không đổi', () => {
  const out = applyToMd(MD, 'B', { mode: 'add', text: '- mới' });
  assert.equal(out, MD.replace('thân b\n', 'thân b\n- mới\n'));
  assert.deepEqual(sectionTitles(out), sectionTitles(MD));
});
test('applyToMd add ở mục cuối giữ xuống dòng cuối tệp', () => {
  const out = applyToMd(MD, 'Nhật ký học', { mode: 'add', text: '- mới' });
  assert.ok(out.endsWith('- cũ\n- mới\n'));
});
test('applyToMd replace: thay thân, mục có khối ``` vẫn đúng', () => {
  const out = applyToMd(MD, 'A', { mode: 'replace', text: 'a mới' });
  assert.ok(out.includes('## A\n\na mới\n\n## B'));
  assert.ok(!out.includes('không phải mục'));
  assert.deepEqual(sectionTitles(out), ['A', 'B', 'Nhật ký học']);
});
test('applyToMd: mục không có ⇒ ném; "## trong khối ```" không phải mục', () => {
  assert.throws(() => applyToMd(MD, 'không phải mục', { mode: 'add', text: 'x' }), /không có trong kho/);
  assert.throws(() => applyToMd(MD, 'Tổng quan', { mode: 'add', text: 'x' }));
});
test('openProposals: chỉ đề xuất đang mở, cũ trước', () => {
  const cs = [
    { id: 5, node_id: 'e2', state: 'open', body: buildProposal({ mode: 'add', text: 'b' }) },
    { id: 3, node_id: 'e1', state: 'open', body: buildProposal({ mode: 'replace', text: 'a' }) },
    { id: 4, node_id: 'e1', state: 'applied', body: buildProposal({ mode: 'add', text: 'c' }) },
    { id: 6, node_id: 'e1', state: 'open', body: 'góp ý thường' },
  ];
  assert.deepEqual(openProposals(cs).map((x) => x.id), [3, 5]);
});
