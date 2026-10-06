#!/usr/bin/env node
/**
 * hooks/identity.mjs — hook UserPromptSubmit + SessionStart của dbio-plugin: chèn dòng "Bạn là <vai> …" do MÁY CHỦ xác nhận vào MỖI lượt
 * (ép vai bằng hook, không trông skill). Đầu vào: JSON hook trên stdin (session_id = cliSessionId). Đầu ra: additionalContext.
 * Lỗi/chậm/không nhận diện được vai ⇒ không in gì, thoát 0 (hook không bao giờ làm kẹt lượt). SessionStart chưa nhận diện được ⇒ nhắc bootstrap 1 dòng.
 */
import { client } from '../lib/common.mjs';
import { buildIdentity, resolveWho } from '../lib/identity.mjs';

let raw = '';
for await (const c of process.stdin) raw += c;
let ev = {};
try { ev = JSON.parse(raw || '{}'); } catch { process.exit(0); }
const event = ev.hook_event_name === 'SessionStart' ? 'SessionStart' : 'UserPromptSubmit';
const out = (text) => { if (text) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })); };

const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
try {
  const cliId = ev.session_id;
  const who = resolveWho({ cliId })?.who;
  if (!who) {
    if (event === 'SessionStart') out('[dbio] Chưa nhận diện được vai của phiên này (tên phiên chưa trùng một nhân viên có khoá trên máy). Đọc playbook `khoi-dong-may-moi` hoặc chạy `dbio-staff bootstrap --as "<vai>"`; đặt tên phiên đúng tên nhân viên.');
    process.exit(0);
  }
  const c = client(who, { throwAuth: true });
  const { line } = await timeout(buildIdentity({
    cliId,
    fetchStatus: async (w) => { const r = await c.ai('staff_status', { who: w, mode: 'get' }); return { state: r.staff?.state, task: r.staff?.task?.ref ?? null }; },
    fetchPlaybooks: async (w) => ((await c.ai('staff_playbook', { who: w, max: 1 })).playbooks ?? []).map((p) => p.slug),
  }), 7000);
  out(line);
} catch { /* im lặng */ }
process.exit(0);
