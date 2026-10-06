/**
 * lib/playbook-propose.mjs — phần THUẦN (không IO; có test) của `dbio playbook propose|proposals|approve|reject` (#822).
 * Nhân viên KHÔNG sửa được playbook nền tảng (department_forbidden) ⇒ đề xuất = góp ý (comment_add) gắn mục online, thân có dấu hiệu máy đọc được:
 *   dòng 1: `[ĐỀ XUẤT thêm]` hoặc `[ĐỀ XUẤT thay]` (+ ` · thẻ #id · bởi <tên>` nếu có) · các dòng sau = chữ đề xuất.
 * Trưởng nhóm duyệt = áp vào bản KHO (chữ gốc, chưa bị MCP che) → đẩy online → đánh dấu applied → commit kho. Không áp lên bản online đọc qua MCP (đã che wrangler→cli…).
 */
import { splitMd } from './playbook-md.mjs';

const HEAD = /^\[ĐỀ XUẤT (thêm|thay)\]([^\n]*)\n?/;

/** mode: 'add' (nối dòng cuối mục) | 'replace' (thay cả thân mục). */
export function buildProposal({ mode, text, card, by }) {
  const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) throw new Error('Thiếu chữ đề xuất.');
  if (!['add', 'replace'].includes(mode)) throw new Error('mode phải là add|replace.');
  const meta = [card ? `thẻ #${String(card).replace(/^#/, '')}` : '', by ? `bởi ${by}` : ''].filter(Boolean).join(' · ');
  return `[ĐỀ XUẤT ${mode === 'add' ? 'thêm' : 'thay'}]${meta ? ` ${meta}` : ''}\n${t}`;
}

/** body góp ý → {mode, text, meta} | null (góp ý thường, không phải đề xuất áp tự động). */
export function parseProposal(body) {
  const s = String(body ?? '').replace(/\r\n/g, '\n');
  const m = HEAD.exec(s);
  if (!m) return null;
  const text = s.slice(m[0].length).trim();
  return text ? { mode: m[1] === 'thêm' ? 'add' : 'replace', text, meta: m[2].trim() } : null;
}

/**
 * Áp 1 đề xuất vào md KHO tại mục có tiêu đề == label (so sau trim). Trả md mới. Ném Error nếu không thấy mục / mục là phần mở đầu.
 * Chỉ sửa đúng mục đó; các mục khác giữ nguyên từng byte (tách theo dòng `## `, bỏ qua trong khối ```).
 */
export function applyToMd(md, label, { mode, text }) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  let fence = false; const heads = [];
  lines.forEach((l, i) => { if (/^\s*```/.test(l)) fence = !fence; if (!fence && /^## /.test(l)) heads.push({ i, title: l.slice(3).trim() }); });
  const k = heads.findIndex((h) => h.title === String(label).trim());
  if (k < 0) throw new Error(`Mục "${label}" không có trong kho (Tổng quan/phần mở đầu chưa hỗ trợ đề xuất tự động — sửa tay + dbio playbook push).`);
  const from = heads[k].i + 1; const to = k + 1 < heads.length ? heads[k + 1].i : lines.length;
  const body = lines.slice(from, to);
  const tail = body.length && body[body.length - 1] === '' ? [''] : [];
  const core = body.join('\n').trim();
  const next = mode === 'replace' ? text.trim() : `${core}\n${text.trim()}`.trim();
  return [...lines.slice(0, from), '', ...next.split('\n'), ...(to < lines.length ? [''] : tail), ...lines.slice(to)].join('\n');
}

/** Số mục có trong md (cùng cách tách với mdToPlaybook) — để kiểm sau khi áp không làm mất/đẻ mục. */
export const sectionTitles = (md) => splitMd(md).sections.map((s) => s.title);

/** Góp ý đang mở dạng đề xuất của một playbook: [{id, node_id, mode, text, meta}] (cũ trước). */
export function openProposals(comments) {
  return (comments ?? []).filter((c) => (c.state ?? 'open') === 'open').map((c) => ({ c, p: parseProposal(c.body) })).filter((x) => x.p)
    .map(({ c, p }) => ({ id: c.id, node_id: c.node_id, ...p })).sort((a, b) => a.id - b.id);
}
