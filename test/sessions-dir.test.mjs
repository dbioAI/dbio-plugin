import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSessionMeta, sessionBaseCandidates, sessionsRoot } from '../lib/sessions-dir.mjs';

const win = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\U\\AppData\\Local', APPDATA: 'C:\\U\\AppData\\Roaming' }, home: 'C:\\U', ls: () => ['Foo_1', 'Claude_pzs8', 'claude_x'] };
test('Windows: đường dẫn MSIX thật đứng TRƯỚC APPDATA', () => {
  const c = sessionBaseCandidates(win);
  assert.match(c[0].replace(/\\/g, '/'), /Packages\/Claude_pzs8\/LocalCache\/Roaming\/Claude$/);
  assert.ok(c.some((p) => p.replace(/\\/g, '/').endsWith('AppData/Roaming/Claude')));
});
test('tiến trình ngoài gói: chỉ đường dẫn MSIX tồn tại ⇒ vẫn tìm thấy', () => {
  const root = sessionsRoot({ ...win, exists: (p) => p.replace(/\\/g, '/').includes('Packages/Claude_pzs8') });
  assert.match(String(root).replace(/\\/g, '/'), /Packages\/Claude_pzs8\/.*claude-code-sessions$/);
});
test('không có chỗ nào ⇒ null; chỉ APPDATA có ⇒ dùng APPDATA', () => {
  assert.equal(sessionsRoot({ ...win, exists: () => false }), null);
  const r = sessionsRoot({ ...win, ls: () => [], exists: (p) => p.replace(/\\/g, '/').includes('AppData/Roaming') });
  assert.match(String(r).replace(/\\/g, '/'), /AppData\/Roaming\/Claude\/claude-code-sessions$/);
});
test('Linux/macOS: chỗ mặc định', () => {
  assert.match(sessionBaseCandidates({ platform: 'linux', home: '/h' })[0], /\.config/);
  assert.match(sessionBaseCandidates({ platform: 'darwin', home: '/h' })[0], /Application Support/);
});

const doc = (o) => JSON.stringify({ sessionId: 'local_abc', cliSessionId: 'x', cwd: 'D:\\\\p', lastActivityAt: 1700000000000, model: 'claude-opus-5-5', isArchived: false, title: 'DEV "AI" CHARACTER', big: 'x'.repeat(50000), ...o });
test('readSessionMeta: chỉ cần phần đầu; title có dấu ngoặc kép/Unicode', () => {
  let asked = 0;
  const m = readSessionMeta('f', { read: (f, n) => { asked = n; return doc({}).slice(0, n); }, readAll: () => { throw new Error('không được đọc cả tệp'); } });
  assert.deepEqual(m, { id: 'local_abc', cli: 'x', title: 'DEV "AI" CHARACTER', model: 'claude-opus-5-5', at: 1700000000000, archived: false });
  assert.ok(asked <= 8192);
});
test('readSessionMeta: archived; title nằm ngoài phần đầu ⇒ đọc cả tệp; hỏng ⇒ null', () => {
  assert.equal(readSessionMeta('f', { read: () => doc({ isArchived: true }) }).archived, true);
  const padded = JSON.stringify({ sessionId: 's', pad: 'y'.repeat(9000), title: 'Muộn', model: 'm', isArchived: false, lastActivityAt: 5 });
  assert.equal(readSessionMeta('f', { read: (f, n) => padded.slice(0, n), readAll: () => padded }).title, 'Muộn');
  assert.equal(readSessionMeta('f', { read: () => { throw new Error('x'); } }), null);
  assert.equal(readSessionMeta('f', { read: () => '{"sessionId":"s"}', readAll: () => '{"sessionId":"s"}' }), null);
});
