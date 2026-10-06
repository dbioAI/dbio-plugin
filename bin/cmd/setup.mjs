#!/usr/bin/env node
/**
 * dbio-staff login | install-skills | bootstrap — dựng MÁY MỚI chỉ từ connector dbio MCP (khoá không đi qua ngữ cảnh model).
 *
 *   login --as "<vai>" [--mcp <url>] [--max-min 10] [--force]
 *       Xin MÃ THIẾT BỊ từ máy chủ, in mã, chờ được duyệt (MCP ai_character staff_key_approve), rồi tự ghi ~/.dbio/staff-keys/<vai>.json. Chỉ in 4 ký tự cuối khoá. Đã có khoá ⇒ từ chối trừ khi --force. Chỉ https (http chỉ cục bộ).
 *   install-skills [--only pm,staff,khoi-dong] [--dry]
 *       Đọc playbook online skill-<tên> (cần khoá) và ghi ~/.claude/skills/<tên>/SKILL.md. Không đè skill đang có nếu khác nội dung mà thiếu --force.
 *   bootstrap --as "<vai>"
 *       login (nếu chưa có khoá) → checkin → whoami → dàn ý playbook của vai → in lệnh bật canh tin nền.
 */
import { existsSync, readFileSync } from 'node:fs';
import { client, die, helpOf, keyFile, keyState, parseArgs, whoAmI } from '../../lib/common.mjs';
import { DEFAULT_MCP_URL, deviceLogin } from '../../lib/device-login.mjs';
import { SKILLS, extractSkill, skillsDir, validSkill, writeSkill } from '../../lib/skills-install.mjs';
import { join } from 'node:path';

const { flags, pos } = parseArgs(process.argv.slice(2), ['--mcp', '--max-min', '--only']);
const [cmd] = pos;
if (!cmd || flags.help) die(helpOf(import.meta.url), 0);

async function login(who) {
  if (keyState(who) === 'ok' && !flags.force) die(`Đã có khoá của "${who}" (${keyFile(who)}). Giữ nguyên; muốn xin khoá mới (thay khoá cũ) thêm --force.`, 2);
  const mcpUrl = flags.mcp || process.env.DBIO_MCP_URL || DEFAULT_MCP_URL;
  const r = await deviceLogin({ mcpUrl, who, file: keyFile(who), maxWaitMs: (Number(flags['max-min']) || 10) * 60_000 });
  if (!r.ok) die(`Đăng nhập thất bại: ${r.reason}. Chạy lại \`dbio-staff login --as "${who}"\` hoặc nhờ chủ duyệt ở dash.`, 2);
  console.log(`ok khoá của "${who}" đã ghi vào ${keyFile(who)} (…${r.tail})`);
}

async function installSkills(who) {
  const c = client(who, flags);
  const only = flags.only ? String(flags.only).split(',').map((s) => s.trim()) : null;
  const out = [];
  for (const s of SKILLS.filter((x) => !only || only.includes(x.name))) {
    const g = await c.call('ai_playbook', { action: 'get', slug: `playbook-${s.slug}`, view: 'text' }).catch((e) => ({ error: e.message }));
    const md = g.error ? null : extractSkill(g.text);
    if (!md || !validSkill(md)) { out.push(`✗ ${s.name}: ${g.error ?? 'playbook thiếu mục SKILL.md hợp lệ'}`); continue; }
    const f = join(skillsDir(), s.name, 'SKILL.md');
    if (existsSync(f) && readFileSync(f, 'utf8') !== md && !flags.force) { out.push(`⚠ ${s.name}: đã có bản khác ở ${f} — thêm --force để ghi đè`); continue; }
    if (flags.dry) { out.push(`[dry] ${s.name} → ${f} (${md.length}B)`); continue; }
    out.push(`✓ ${s.name} → ${writeSkill(s.name, md)}`);
  }
  console.log(out.join('\n'));
}

async function bootstrap(who) {
  if (keyState(who) !== 'ok') await login(who);
  const c = client(who, flags);
  await c.init();
  const pulse = await c.ai('staff_pulse', { who });
  console.log(`ok ${who} · chưa đọc ${pulse.unread?.count ?? 0} · sổ cái ${c.board}`);
  try { await c.ai('staff_checkin', { who }); console.log('ok checkin'); } catch (e) { console.log(`⚠ checkin: ${e?.message ?? e}`); }
  console.log(`Tiếp: node <plugin>/bin/dbio-staff.mjs playbook get <slug-vai> --as "${who}"  ·  bật canh tin nền (run_in_background): node <plugin>/bin/dbio-staff.mjs staff watch --as "${who}" --max-min 115`);
}

try {
  if (cmd === 'login') await login(whoAmI(flags));
  else if (cmd === 'install-skills') await installSkills(whoAmI(flags));
  else if (cmd === 'bootstrap') await bootstrap(whoAmI(flags));
  else die(`Lệnh lạ "${cmd}".`);
} catch (e) { die(`lỗi: ${e?.message ?? e}`); }
