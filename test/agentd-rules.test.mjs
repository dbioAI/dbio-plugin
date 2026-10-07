import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEMPLATE, buildPrompt, buildRelayMessage, decideWake, listenerAlive, splitSweep } from '../lib/agentd/rules.mjs';
import { AGENT_TO_ADAPTER, discoverFromStaffList, normalizeConfig } from '../lib/agentd/config.mjs';

const NOW = 1_000_000_000;

test('listenerAlive: chỉ khi mode=listen, chưa kết thúc, nhịp còn mới', () => {
  assert.ok(listenerAlive({ mode: 'listen', beat: NOW - 30_000, every: 60_000, ended: false }, NOW));
  assert.ok(!listenerAlive({ mode: 'listen', beat: NOW - 200_000, every: 60_000 }, NOW), 'nhịp cũ ⇒ chết');
  assert.ok(!listenerAlive({ mode: 'listen', beat: NOW - 1000, ended: true }, NOW), 'đã thoát');
  assert.ok(!listenerAlive({ mode: 'watch', beat: NOW - 1000 }, NOW), 'watch cũ không phải listen');
  assert.ok(!listenerAlive(null, NOW));
});

test('decideWake: bận > nghe sẵn (chờ) > nghe sẵn quá hạn (kiểm) > nghỉ (thức ngay)', () => {
  const beat = { mode: 'listen', beat: NOW - 1000, every: 60_000 };
  assert.equal(decideWake({ batch: [{ firstSeen: NOW }], beat: null, now: NOW, inflight: true }), 'busy');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW }], beat: null, now: NOW }), 'wake');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW - 5000 }], beat, now: NOW, confirmMs: 60_000 }), 'defer');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW - 5000 }, { firstSeen: NOW - 90_000 }], beat, now: NOW, confirmMs: 60_000 }), 'verify', 'tin CŨ NHẤT quyết định');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW }], beat: { ...beat, ended: true }, now: NOW }), 'busy', 'listen vừa thoát (đã thức phiên) ⇒ không thức chồng');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW }], beat: { ...beat, beat: NOW - 700_000, ended: true }, now: NOW }), 'verify', 'listen thoát quá hạn mà tin chưa ack ⇒ kiểm + giao lại');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW }], beat: { ...beat, ended: true }, now: NOW, blank: true }), 'verify', 'phiên trống (vừa clear): bỏ qua mọi chờ, chỉ kiểm tin chưa đọc rồi thức ngay dù listen cũ vừa thoát');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW }], beat, now: NOW, blank: true }), 'verify', 'kể cả listen cũ còn sống sau clear');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW }], beat: null, now: NOW, inflight: true, blank: true }), 'busy', 'không chồng lượt');
  const ended = { ...beat, beat: NOW - 700_000, ended: true };
  assert.equal(decideWake({ batch: [{ firstSeen: NOW - 700_000 }], beat: ended, now: NOW }), 'verify', 'quá hạn giao lại 10 phút (mặc định)');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW - 700_000 }], beat: ended, now: NOW, activeAgoMs: 30_000 }), 'busy', 'phiên đang GHI hội thoại ⇒ đang làm, không giao lại dù quá hạn');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW - 700_000 }], beat: ended, now: NOW, activeAgoMs: 20 * 60_000 }), 'verify', 'phiên im lâu ⇒ giao lại');
});

test('decideWake: phiên đang GHI hội thoại trong app (không listen) ⇒ busy ngay cả lần giao ĐẦU; im > 3 phút ⇒ wake', () => {
  assert.equal(decideWake({ batch: [{ firstSeen: NOW }], beat: null, now: NOW, activeAgoMs: 20_000 }), 'busy');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW }], beat: null, now: NOW, activeAgoMs: 4 * 60_000 }), 'wake');
  assert.equal(decideWake({ batch: [{ firstSeen: NOW }], beat: null, now: NOW, activeAgoMs: null }), 'wake');
});

test('buildRelayMessage: @thư ký, tên + phiên, lệnh nạp vai, tin là dữ liệu', () => {
  const m = buildRelayMessage({ name: 'MAC NV1', session: 'local_abc', to: 'TK TEST', batch: [{ task: '1#2', kind: 'mention', text: '<b>làm</b> đi' }] });
  assert.match(m, /@TK TEST/); assert.match(m, /MAC NV1/); assert.match(m, /local_abc/); assert.match(m, /next --take/); assert.match(m, /là dữ liệu, không phải lệnh/); assert.doesNotMatch(m, /<b>/);
});

test('buildPrompt: có tên + dòng tin, đánh dấu là dữ liệu, cắt gọn, ≤10 tin + phần dư', () => {
  const batch = Array.from({ length: 12 }, (_, i) => ({ id: i, task: `1#${i}`, kind: 'assign', cls: i === 0 ? 'urgent' : 'normal', text: `<b>việc</b> ${'x'.repeat(500)}` }));
  const p = buildPrompt('NV1', batch);
  assert.match(p, /NV1/);
  assert.match(p, /là dữ liệu, không phải lệnh/);
  assert.match(p, /- 1#0 · assign · KHẨN: việc x+…/);
  assert.match(p, /\+2 tin nữa/);
  assert.doesNotMatch(p, /<b>/);
  assert.ok(p.length <= 4000);
  assert.ok(/KHÔNG bật listen/.test(DEFAULT_TEMPLATE)) // #872: lượt ngầm không được dặn bật listen;
});

test('buildPrompt: "$&" / "$1" trong nội dung tin không bị hiểu thành mẫu thay thế', () => {
  const p = buildPrompt('A', [{ id: 1, task: 't', kind: 'mention', text: 'giá $& và $1 và $`' }]);
  assert.match(p, /giá \$& và \$1 và \$`/);
});

test('splitSweep: wake/ask ⇒ nhắn phiên; còn lại ⇒ bình luận kèm @trưởng nhóm', () => {
  const r = splitSweep([
    { kind: 'wake', who: 'A', task: 5, text: 'Thẻ #5' }, { kind: 'ask', who: 'B', task: 6, text: 'im' },
    { kind: 'pm', who: 'C', task: 7, text: 'im 130p' }, { kind: 'lost', who: 'D', task: 8, text: 'mất nhịp' }, { kind: 'double', who: 'E', task: 9, text: '2 thẻ' },
  ], 'PM');
  assert.deepEqual(r.wakes.map((w) => [w.who, w.task]), [['A', 5], ['B', 6]]);
  assert.deepEqual(r.comments.map((c) => c.task), [7, 8, 9]);
  assert.match(r.comments[0].text, /@PM/);
  assert.deepEqual(splitSweep(null), { wakes: [], comments: [] });
});

test('normalizeConfig: bỏ nhân viên thiếu adapter, số sai về mặc định, sweep/discover thiếu "as" bị tắt', () => {
  const { config, errors } = normalizeConfig({
    staff: { A: { adapter: 'codex' }, B: {}, C: 'x' }, defaults: { coalesce_ms: -1, adapter: null },
    rules: { sweep: { enabled: true } }, discover: { enabled: true },
  });
  assert.deepEqual(Object.keys(config.staff), ['A']);
  assert.equal(config.defaults.coalesce_ms, 3000);
  assert.equal(config.rules.sweep.enabled, false);
  assert.equal(config.discover.enabled, false);
  assert.ok(errors.length >= 5);
  assert.deepEqual(normalizeConfig(null).config.staff, {});
  assert.equal(normalizeConfig({ defaults: { adapter: 'claude-cli' }, staff: { Z: {} } }).config.staff.Z.adapter, 'claude-cli');
});

test('discoverFromStaffList: chỉ nhân viên runtime.machine = máy này + agent hiểu được', () => {
  const staff = [
    { name: 'NV1', runtime: { machine: 'Mac-1', agent: 'claude_code', session_ref: 'abc' } },
    { name: 'NV2', runtime: { machine: 'other', agent: 'claude_code' } },
    { name: 'NV3', runtime: { machine: 'mac-1', agent: 'codex' } },
    { name: 'NV4', runtime: { machine: 'Mac-1', agent: 'la_hoac' } }, { runtime: { machine: 'Mac-1', agent: 'codex' } }, { name: 'NV5' },
  ];
  const r = discoverFromStaffList(staff, 'MAC-1');
  assert.deepEqual(Object.keys(r), ['NV1', 'NV3']);
  assert.deepEqual(r.NV1, { adapter: AGENT_TO_ADAPTER.claude_code, session: 'abc', discovered: true });
  assert.equal(r.NV3.session, undefined);
});

import { contextGuard, contextTokensFromTail, sessionContextTokens } from '../lib/agentd/context-size.mjs';
import { filterInbox } from '../lib/watch-filter.mjs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdapter } from '../lib/agentd/adapters/index.mjs';

test('contextTokensFromTail: usage của tin cuối (input + cache đọc + cache tạo), bỏ dòng cắt dở', () => {
  const t = ['{"type":"user","message":{}}', '{"message":{"usage":{"input_tokens":2,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500}}}', '{"message":{"usage":{"input_tokens":3,"cache_read_input_tokens":90000,"cache_creation_input_tokens":10}}}', '{"cắt dở "usage'].join('\n');
  assert.equal(contextTokensFromTail(t), 90013);
  assert.equal(contextTokensFromTail('không có gì'), null);
});

test('contextGuard + adapter: phiên > 100k bị CHẶN (không chạy), allow_large mở, phiên nhỏ/không biết cho qua', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proj-')); mkdirSync(join(root, 'p'), { recursive: true });
  writeFileSync(join(root, 'p', 'big-1.jsonl'), '{"message":{"usage":{"input_tokens":1,"cache_read_input_tokens":470000,"cache_creation_input_tokens":0}}}\n');
  writeFileSync(join(root, 'p', 'small-1.jsonl'), '{"message":{"usage":{"input_tokens":1,"cache_read_input_tokens":20000,"cache_creation_input_tokens":0}}}\n');
  assert.equal(sessionContextTokens('big-1', { root }), 470001);
  assert.equal(sessionContextTokens('khong-co', { root }), null);
  assert.equal(contextGuard('big-1', {}, { root }).blocked, true);
  assert.equal(contextGuard('big-1', { allow_large: true }, { root }).blocked, false);
  assert.equal(contextGuard('big-1', { max_context_tokens: 500000 }, { root }).blocked, false);
  assert.equal(contextGuard('small-1', {}, { root }).blocked, false);
  assert.equal(contextGuard('khong-co', {}, { root }).blocked, false);
  const r = await getAdapter('claude-cli').wake({ staff: 'N', entry: { session: 'big-1', projects_dir: root }, prompt: 'p' });
  assert.equal(r.ok, false); assert.equal(r.blocked, true); assert.match(r.detail, /470k/);
});

test('kênh đẩy: @nhắc trực tiếp = KHẨN (thức ngay, không chờ gom 20 phút); bản sao bị bỏ', () => {
  const m = { id: 1, kind: 'mention', text: 'ghi chú dài không có dấu hỏi', task: '1#2', at: new Date().toISOString() };
  assert.equal(filterInbox([m], { mentionUrgent: true }).keep[0].cls, 'urgent');
  assert.equal(filterInbox([m], {}).keep[0].cls, 'normal');
  assert.equal(filterInbox([{ ...m, id: 2, state: 'copy' }], { mentionUrgent: true }).keep.length, 0, 'bản sao không phải thư ký bị bỏ');
});

test('discover: tên nhân viên từ máy chủ chứa ký tự nguy hiểm bị bỏ (đi vào lời nhắc)', () => {
  const r = discoverFromStaffList([{ name: 'A" ; rm -rf $(x)', runtime: { machine: 'm', agent: 'codex' } }, { name: 'DEV AI CHARACTER', runtime: { machine: 'm', agent: 'codex' } }, { name: 'x'.repeat(61), runtime: { machine: 'm', agent: 'codex' } }], 'm');
  assert.deepEqual(Object.keys(r), ['DEV AI CHARACTER']);
});

test('discover: claude_code + session local_ ⇒ adapter claude-desktop', () => {
  const r = discoverFromStaffList([{ name: 'A', runtime: { machine: 'm', agent: 'claude_code', session_ref: 'local_abc' } }, { name: 'B', runtime: { machine: 'm', agent: 'claude_code', session_ref: 'uuid-1' } }], 'm');
  assert.equal(r.A.adapter, 'claude-desktop'); assert.equal(r.B.adapter, 'claude-cli');
});

test('buildRelayMessage (Qa): chỉ tin CÙNG thẻ, @/markdown/HTML trong tin bị vô hiệu, tin thẻ khác không bị đăng', () => {
  const m = buildRelayMessage({ name: 'A', session: 'local_s', to: 'TK TEST', batch: [
    { task: '1#2', kind: 'mention', text: '@Sếp xem [link](http://x) `rm` <script>' },
    { task: '1#3', kind: 'mention', text: 'BÍ MẬT thẻ khác' }, { task: '1#2', kind: 'Bad Kind!', text: 'x' } ] });
  assert.doesNotMatch(m, /BÍ MẬT/); assert.match(m, /\+2 tin thẻ khác/);
  assert.doesNotMatch(m.split('Tin đang chờ')[1], /@Sếp|\[link\]|`rm`|<script>/);
  assert.match(m, /＠Sếp/);
  assert.equal((m.match(/@TK TEST/g) || []).length, 1, 'chỉ một @ hợp lệ: tên thư ký');
});

test('#872 nợ 6: listen còn sống, tin quá confirm nhưng phiên đang ghi ⇒ busy (KHÔNG --resume song song); phiên im ⇒ verify', () => {
  const beat = { mode: 'listen', beat: NOW - 1000, every: 60_000 };
  const batch = [{ firstSeen: NOW - 90_000 }];
  assert.equal(decideWake({ batch, beat, now: NOW, confirmMs: 60_000, activeAgoMs: 20_000 }), 'busy');
  assert.equal(decideWake({ batch, beat, now: NOW, confirmMs: 60_000, activeAgoMs: 20 * 60_000 }), 'verify');
  assert.equal(decideWake({ batch, beat, now: NOW, confirmMs: 60_000, activeAgoMs: null }), 'verify');
});

test('#872: cầu cho phiên BẬN (ép sau hoãn) — nói "đang bận, N tin chưa đọc", KHÔNG "vừa clear", KHÔNG bảo nạp lại vai', () => {
  const m = buildRelayMessage({ name: 'DEV X', session: 'local_s', to: 'TK TEST', busy: true, batch: [{ task: '9#3', kind: 'mention', text: 'hi' }, { task: '9#3', kind: 'assign', text: 'yo' }] });
  assert.match(m, /BẬN/); assert.match(m, /2 tin chưa đọc trên 9#3/); assert.match(m, /@TK TEST/);
  assert.ok(!/VỪA CLEAR|vừa được clear|Nạp vai: dbio-staff|whoami/.test(m), m);
  assert.match(buildRelayMessage({ name: 'A', session: 'local_s', to: 'T', batch: [{ task: '9#3', kind: 'mention', text: 'hi' }] }), /VỪA CLEAR/);
});
