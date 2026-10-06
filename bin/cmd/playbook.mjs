#!/usr/bin/env node
/**
 * dbio-staff playbook — đọc / góp ý AI Playbook ONLINE của vai, GỌN theo mục.
 *
 *   get <slug> [--section "<từ khoá>"] [--full]   đọc online qua MCP ai_playbook (slug playbook-<slug>). Mặc định: DÀN Ý (các mục);
 *                                                 --section in một mục; --full in cả bài. Online lỗi ⇒ LỖI thoát 1 (không có bản sao dự phòng).
 *   propose <slug> --section "<mục>" (--add "<dòng nối>" | --text "<thân mới>") [--card <thẻ>] [--dry]
 *                                                 góp ý sửa/thiếu: Trưởng nhóm duyệt. KHÔNG tự sửa playbook.
 *   log <slug> "<điều mới học>" [--dry]           = propose --add 1 dòng có ngày vào mục "Nhật ký học"
 *
 * Cần khoá nhân viên (--as hoặc DBIO_STAFF).
 */
import { client, die, helpOf, keyState, parseArgs, whoAmI } from '../../lib/common.mjs';
import { getPlaybook } from '../../lib/playbook-get.mjs';
import { buildProposal } from '../../lib/playbook-propose.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2), ['--section', '--text', '--add', '--card']);
const [cmd, ...rest] = pos;
if (!cmd || flags.help) die(helpOf(import.meta.url), 0);
const onlineSlug = (slug) => `playbook-${String(slug).replace(/\.md$/, '')}`;

async function onlineOf(c, slug) {
  const list = (await c.call('ai_playbook', { action: 'list' })).playbooks ?? [];
  const hit = list.find((p) => (p.slug ?? p.id) === onlineSlug(slug));
  if (!hit) die(`Không có playbook online "${slug}".`);
  const g = await c.call('ai_playbook', { action: 'get', profile_id: hit.profile_id });
  return { profile_id: hit.profile_id, nodes: g.playbook?.nodes ?? g.nodes ?? [] };
}

const cmds = {
  async get() {
    const slug = String(rest[0] ?? '').replace(/\.md$/, '');
    if (!slug) die('Dùng: dbio-staff playbook get <slug> [--section "<từ khoá>"] [--full] --as "<nhân viên>"');
    const who = flags.as || process.env.DBIO_STAFF || null;
    let c = null;
    const api = () => (c ??= client(who, { ...flags, throwAuth: true }), {
      outline: (s) => c.call('ai_playbook', { action: 'get', slug: s }),
      text: (s, g) => c.call('ai_playbook', { action: 'get', slug: s, view: 'text', ...(g ? { section: g } : {}) }),
    });
    const r = await getPlaybook(slug, { section: flags.section, full: flags.full }, {
      keyStatus: () => (who ? keyState(who) : 'missing'),
      api: () => api(),
      readLocalText: () => { throw new Error('không có bản sao cục bộ'); },
    }, 'online');
    if (r.warning) console.error(r.warning);
    const out = r.lines.join(String.fromCharCode(10));
    if (r.code) die(out, 1);
    console.log(out);
  },
  async log() {
    const note = rest.slice(1).join(' ').trim();
    if (!note) die('Thiếu nội dung điều mới học.');
    flags.section = 'Nhật ký học'; flags.add = `- ${new Date().toISOString().slice(0, 10)} ${note}`; delete flags.text;
    await cmds.propose();
  },
  async propose() {
    const slug = String(rest[0] ?? '').replace(/\.md$/, '');
    const sec = flags.section && flags.section !== true ? String(flags.section) : '';
    if (!slug || !sec || (flags.add == null) === (flags.text == null)) die('Dùng: dbio-staff playbook propose <slug> --section "<tiêu đề mục>" (--add "<dòng nối>" | --text "<thân mới>") [--card <thẻ>] [--dry] --as "<nhân viên>"');
    const who = whoAmI(flags);
    const body = buildProposal({ mode: flags.add != null ? 'add' : 'replace', text: String(flags.add ?? flags.text), card: flags.card && flags.card !== true ? flags.card : '', by: who });
    const c = client(who, flags);
    const { profile_id: pid, nodes } = await onlineOf(c, slug);
    const hit = nodes.filter((n) => String(n.label).trim().toLowerCase().includes(sec.toLowerCase()));
    const exact = hit.filter((n) => String(n.label).trim().toLowerCase() === sec.toLowerCase());
    const pick = exact.length === 1 ? exact[0] : hit.length === 1 ? hit[0] : null;
    if (!pick) die(`Mục "${sec}" ${hit.length ? 'khớp nhiều: ' + hit.map((n) => n.label).join(' | ') : 'không có'}. Mục: ${nodes.map((n) => n.label).join(' | ')}`);
    if (flags.dry) { console.log(`[dry] ${slug} · mục "${pick.label}" (${pick.id})\n${body}`); return; }
    const r = await c.call('ai_playbook', { action: 'comment_add', profile_id: pid, node_id: pick.id, body, author_name: who });
    console.log(`ok đề xuất #${r.comment_id} · ${slug} · mục "${pick.label}" · chờ Trưởng nhóm duyệt`);
  },
};
if (!cmds[cmd]) die(`Lệnh lạ "${cmd}". Có: ${Object.keys(cmds).join(' · ')}`);
try { await cmds[cmd](); } catch (e) { die(`lỗi: ${e?.message ?? e}`); }
