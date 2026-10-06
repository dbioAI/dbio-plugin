#!/usr/bin/env node
/**
 * hooks/identity.mjs — hook UserPromptSubmit + SessionStart của dbio-plugin: chèn dòng "Bạn là <vai> …" do MÁY CHỦ xác nhận vào MỖI lượt
 * (ép vai bằng hook, không trông skill). Đầu vào: JSON hook trên stdin (session_id = cliSessionId). Đầu ra: additionalContext.
 * Lỗi/chậm/không nhận diện được vai ⇒ không in gì, thoát 0 (hook không bao giờ làm kẹt lượt). SessionStart chưa nhận diện được ⇒ nhắc bootstrap 1 dòng.
 */
import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { client } from '../lib/common.mjs';
import { buildIdentity, identityDir, resolveWho } from '../lib/identity.mjs';

let raw = '';
for await (const c of process.stdin) raw += c;
let ev = {};
try { ev = JSON.parse(raw || '{}'); } catch { process.exit(0); }
const event = ev.hook_event_name === 'SessionStart' ? 'SessionStart' : 'UserPromptSubmit';
const out = (text) => { if (text) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })); };

/** Cài cả dbio-plugin lẫn dbio-internal ⇒ hook chạy 2 lần: chỉ MỘT lần in (tạo tệp khoá độc quyền theo phiên + sự kiện + khung 3 giây). */
function firstInWindow(cliId) {
  try {
    const dir = identityDir(); mkdirSync(dir, { recursive: true });
    const stamp = join(dir, `${String(cliId ?? 'x').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}.${event}.${Math.floor(Date.now() / 3000)}.emit`);
    closeSync(openSync(stamp, 'wx'));
    for (const f of readdirSync(dir)) if (f.endsWith('.emit') && Date.now() - statSync(join(dir, f)).mtimeMs > 60_000) { try { unlinkSync(join(dir, f)); } catch { /* bỏ */ } }
    return true;
  } catch (e) { return e?.code !== 'EEXIST'; }
}
const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
try {
  const cliId = ev.session_id;
  if (!firstInWindow(cliId)) process.exit(0); // bản hook kia đã in
  const who = resolveWho({ cliId })?.who;
  if (!who) {
    if (event === 'SessionStart') out('[dbio] Chưa nhận diện được vai của phiên này (tên phiên chưa trùng một nhân viên có khoá trên máy). Đọc playbook `khoi-dong-may-moi` hoặc chạy `dbio-staff bootstrap --as "<vai>"`; đặt tên phiên đúng tên nhân viên.');
    process.exit(0);
  }
  const c = client(who, { throwAuth: true });
  const { line } = await timeout(buildIdentity({
    cliId,
    fetchStatus: async (w) => { const r = await c.ai('staff_status', { who: w, mode: 'get' }); return { state: r.staff?.state, task: r.staff?.task?.ref ?? null, name: r.staff?.name ?? null }; },
    fetchPlaybooks: async (w) => ((await c.ai('staff_playbook', { who: w, max: 1 })).playbooks ?? []).map((p) => p.slug),
  }), 7000);
  out(line);
} catch { /* im lặng */ }
process.exit(0);
