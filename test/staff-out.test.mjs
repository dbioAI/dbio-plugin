import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../lib/common.mjs';
import { buildReason, isHttps, localFilesOf, mediaUrlOf, OUT_HINT, OUT_WARN, outGate, outLine, parseOut, PDF_HINT, requireOutOn, toDeliverable } from '../lib/staff-logic.mjs';

// ---- #738 BÀN GIAO CÓ KIỂU: dbio staff done --out
test('parseArgs: --out lặp được ⇒ mảng; cờ thường vẫn như cũ', () => {
  const { flags, pos } = parseArgs(['done', '738', '--out', 'image=a.png', '--state', 'x', '--out', 'url=https://a.b'], ['--state'], ['--out']);
  assert.deepEqual(flags.out, ['image=a.png', 'url=https://a.b']);
  assert.equal(flags.state, 'x');
  assert.deepEqual(pos, ['done', '738']);
  assert.equal(parseArgs(['done'], [], ['--out']).flags.out, undefined);
});
test('parseOut: type=value|title|extra; kiểu lạ / thiếu giá trị ⇒ ném; code được trống', () => {
  assert.deepEqual(parseOut('image=D:/s/a.png|Popup 390|390,dark'), { type: 'image', value: 'D:/s/a.png', title: 'Popup 390', extra: '390,dark' });
  assert.deepEqual(parseOut('URL=https://app.example.com/x'), { type: 'url', value: 'https://app.example.com/x', title: null, extra: null });
  assert.deepEqual(parseOut('code'), { type: 'code', value: '', title: null, extra: null });
  assert.throws(() => parseOut('pdf=a.pdf'), /kiểu phải là/);
  assert.throws(() => parseOut('image='), /thiếu giá trị/);
  assert.throws(() => parseOut('nonsense'), /kiểu phải là/);
});
test('localFilesOf: chỉ đường dẫn máy của image/video/file + ảnh web + poster', () => {
  assert.deepEqual(localFilesOf(parseOut('image=C:\s\a.png')), ['C:\s\a.png']);
  assert.deepEqual(localFilesOf(parseOut('image=https://cdn.example.com/a.png')), []);
  assert.deepEqual(localFilesOf(parseOut('web=https://x.vn|T|a.png,https://c/b.png')), ['a.png']);
  assert.deepEqual(localFilesOf(parseOut('video=https://c/v.mp4|T|p.png')), ['p.png']);
  assert.deepEqual(localFilesOf(parseOut('text=xin chào/abc.png')), []);
  assert.deepEqual(localFilesOf(parseOut('url=scratch/a.png')), []); // url không tự tải — server từ chối đường dẫn máy
});
test('toDeliverable: thay đường dẫn máy bằng link đã tải; meta theo kiểu; code tự lấy git', () => {
  const up = { 'a.png': 'https://cdn.example.com/stores/1/a.png', 'p.png': 'https://cdn.example.com/stores/1/p.png' };
  assert.deepEqual(toDeliverable(parseOut('image=a.png|Popup|390,tối'), up), { type: 'image', title: 'Popup', value: up['a.png'], meta: { width: 390, theme: 'dark' } });
  assert.deepEqual(toDeliverable(parseOut('web=https://x.vn|Trang|a.png'), up), { type: 'web', title: 'Trang', value: 'https://x.vn', meta: { shots: [up['a.png']] } });
  assert.deepEqual(toDeliverable(parseOut('video=https://c/v.mp4||p.png'), up), { type: 'video', value: 'https://c/v.mp4', meta: { poster: up['p.png'] } });
  assert.deepEqual(toDeliverable(parseOut('url=https://d|Dash|production')), { type: 'url', title: 'Dash', value: 'https://d', meta: { env: 'production' } });
  assert.deepEqual(toDeliverable(parseOut('text=Bài viết dài'), up), { type: 'text', value: 'Bài viết dài' });
  assert.deepEqual(toDeliverable(parseOut('code'), {}, { repo: 'backend', head: 'b65960a', branch: 'wt/backend-t738' }), { type: 'code', value: 'backend@b65960a', meta: { branch: 'wt/backend-t738' } });
  assert.deepEqual(toDeliverable(parseOut('code=client-frontend@abc1234||https://app.example.com')), { type: 'code', value: 'client-frontend@abc1234', meta: { live: 'https://app.example.com' } });
  assert.throws(() => toDeliverable(parseOut('code'), {}, null), /worktree/);
  // chưa tải ⇒ giữ nguyên (server từ chối đường dẫn máy, không lọt im lặng)
  assert.equal(toDeliverable(parseOut('image=b.png'), up).value, 'b.png');
});
test('outGate #809 (BẬT — mặc định): mức ok / done thiếu --out XEM ĐƯỢC ⇒ error, kể cả --no-code; code / text không tính', () => {
  const on = { require: true };
  assert.deepEqual(outGate({ outs: [], ...on }), { error: OUT_HINT, warn: null });
  assert.deepEqual(outGate({ outs: [parseOut('code')], ...on }), { error: OUT_HINT, warn: null });
  assert.deepEqual(outGate({ outs: [parseOut('text=đã làm')], ...on }), { error: OUT_HINT, warn: null });
  assert.deepEqual(outGate({ level: 'done', outs: [], ...on }), { error: OUT_HINT, warn: null });
  assert.deepEqual(outGate({ outs: [parseOut('url=https://a.b')], ...on }), { error: null, warn: null });
  assert.deepEqual(outGate({ outs: [parseOut('image=https://a.b/x.png')], ...on }), { error: null, warn: null });
});
test('outGate #809: review / blocked không cần bàn giao; --no-deliverable chỉ có tác dụng ở review / blocked; cờ thiếu lý do ⇒ error', () => {
  assert.deepEqual(outGate({ level: 'review', outs: [] }), { error: null, warn: null });
  assert.deepEqual(outGate({ level: 'BLOCKED', outs: [] }), { error: null, warn: null });
  assert.deepEqual(outGate({ level: 'review', outs: [], noDeliverable: 'chọn hướng' }), { error: null, warn: null });
  assert.deepEqual(outGate({ outs: [], noDeliverable: 'refactor thuần' }), { error: OUT_HINT, warn: null });
  assert.match(outGate({ outs: [], noDeliverable: true }).error, /cần lý do/);
  assert.match(outGate({ outs: [], noDeliverable: '  ' }).error, /cần lý do/);
});
test('outGate TẮT (DBIO_DONE_REQUIRE_OUT=0): thiếu ⇒ warn, không error', () => {
  assert.deepEqual(outGate({ outs: [], require: false }), { error: null, warn: OUT_WARN });
  assert.deepEqual(outGate({ outs: [parseOut('web=https://a.b')], require: false }), { error: null, warn: null });
});
test('requireOutOn #809: mặc định BẬT; config staff.done_require_out=false tắt; env thắng cấu hình', () => {
  assert.equal(requireOutOn({}, {}), true);
  assert.equal(requireOutOn({}, { staff: { done_require_out: false } }), false);
  assert.equal(requireOutOn({}, { staff: { done_require_out: true } }), true);
  assert.equal(requireOutOn({ DBIO_DONE_REQUIRE_OUT: '0' }, { staff: { done_require_out: true } }), false);
  assert.equal(requireOutOn({ DBIO_DONE_REQUIRE_OUT: '1' }, { staff: { done_require_out: false } }), true);
});
test('PDF: tệp .pdf trên máy ⇒ lỗi rõ (kho chưa nhận PDF); link https …pdf vẫn nhận; txt/ảnh vẫn tải', () => {
  assert.throws(() => parseOut('file=D:/x/bao-cao.pdf|Báo cáo'), (e) => e.message.includes(PDF_HINT) && !e.message.includes('\n'));
  assert.throws(() => parseOut('file=bao-cao.PDF'), /kho chưa nhận PDF/);
  assert.throws(() => parseOut('image=a.pdf'), /kho chưa nhận PDF/);
  assert.throws(() => parseOut('web=https://a.b|Trang|shot.png,x.pdf'), /kho chưa nhận PDF/);
  assert.deepEqual(parseOut('file=https://cdn.example.com/stores/1/bao-cao.pdf|Báo cáo'), { type: 'file', value: 'https://cdn.example.com/stores/1/bao-cao.pdf', title: 'Báo cáo', extra: null });
  assert.deepEqual(localFilesOf(parseOut('file=https://a.b/c.pdf')), []);
  assert.deepEqual(localFilesOf(parseOut('file=ghi-chu.txt')), ['ghi-chu.txt']);
  assert.deepEqual(localFilesOf(parseOut('file=thexpdf')), ['thexpdf'], 'chỉ chặn đuôi .pdf thật');
  assert.deepEqual(localFilesOf(parseOut('image=shot.png')), ['shot.png']);
});
test('buildReason mang deliverables (không rỗng); outLine; mediaUrlOf; isHttps', () => {
  const d = [{ type: 'url', value: 'https://a.b' }];
  assert.deepEqual(buildReason({ state: 'x', deliverables: d }), { level: 'ok', text: 'x', result: { summary: 'x' }, deliverables: d });
  assert.ok(!('deliverables' in buildReason({ state: 'x', deliverables: [] })));
  assert.equal(outLine([{ type: 'image', title: 'Popup', value: 'https://c/a.png' }, { type: 'text', value: 'a  b' }]), 'image Popup → https://c/a.png · text → "a b"');
  assert.equal(outLine([]), null);
  assert.equal(mediaUrlOf({ success: true, data: { id: 1, url: 'https://cdn.example.com/stores/1/a.png' } }), 'https://cdn.example.com/stores/1/a.png');
  assert.equal(mediaUrlOf({ url: 'https://x/y' }), 'https://x/y');
  assert.equal(mediaUrlOf({ error: 'TICKET_USED' }), null);
  assert.ok(isHttps('https://a.b/c')); assert.ok(!isHttps('http://a.b')); assert.ok(!isHttps('C:\a.png'));
});

import { boardFromTeams } from '../lib/common.mjs';
test('boardFromTeams: sổ cái theo nhóm có tên mình; nhiều nhóm ⇒ thẻ đang cầm › nhóm chính › đầu tiên; không thuộc nhóm ⇒ null', () => {
  const m = (name, o = {}) => ({ name, teams: [], task: null, ...o });
  const T = (id, board, members) => ({ id, ledger_board_id: board, members });
  assert.equal(boardFromTeams([T(1, 100, [m('A')])], ' a '), 100);
  assert.equal(boardFromTeams([T(1, 100, [m('B')])], 'A'), null);
  assert.equal(boardFromTeams([T(1, 100, [m('A')]), T(2, 200, [m('A', { teams: [{ id: 2, primary: true }] })])], 'A'), 200);
  assert.equal(boardFromTeams([T(1, 100, [m('A', { task: { board_id: 100 } })]), T(2, 200, [m('A', { teams: [{ id: 2, primary: true }] })])], 'A'), 100);
  assert.equal(boardFromTeams([T(1, 0, [m('A')])], 'A'), null);
  assert.equal(boardFromTeams(undefined, 'A'), null);
});
