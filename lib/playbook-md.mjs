/**
 * md ↔ AI Playbook (kind=knowledge) — hàm THUẦN, không I/O. Dùng bởi `dbio playbook push` (#730).
 *
 * Hình dạng khớp 10 playbook nạp tay ngày 1/10 (thẻ #648): mỗi mục `## ` = 1 entry (nodes[i], id e<i>) + 1 group riêng (g<i>) cùng tiêu đề;
 * label = tiêu đề mục; detail = thân mục (giữ nguyên markdown, gồm cả ### con); x = { asks, when, verified_at }.
 * Phần đầu tệp (trước `##` đầu tiên, bỏ dòng `# tiêu đề`) nếu có chữ ⇒ thêm 1 mục đầu "Tổng quan" (vd. "Model: Sonnet. Vai: …").
 * Dòng `## ` nằm trong khối ``` KHÔNG tách mục.
 */

/** Tách md thành { h1, intro, sections:[{title, body}] }. */
export function splitMd(md) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  let h1 = ''; const intro = []; const sections = []; let cur = null; let fence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) fence = !fence;
    if (!fence && /^## /.test(l)) { cur = { title: l.slice(3).trim(), lines: [] }; sections.push(cur); continue; }
    if (!fence && !cur && !h1 && /^# /.test(l)) { h1 = l.slice(2).trim(); continue; }
    (cur ? cur.lines : intro).push(l);
  }
  const trim = (a) => a.join('\n').trim();
  return { h1, intro: trim(intro), sections: sections.map((s) => ({ title: s.title, body: trim(s.lines) })) };
}

const lower = (s) => s.toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
const words = (slug) => String(slug).replace(/-/g, ' ');

/** Tên hiển thị từ H1: bỏ phần sau " — " ("THƯ KÝ — playbook (…)" → "THƯ KÝ"); H1 trùng slug ⇒ dùng slug. */
export function nameOf(h1, slug) {
  const n = String(h1 ?? '').split(' — ')[0].trim();
  return n || slug;
}

/**
 * md → playbook JSON.
 * opts: { today:'YYYY-MM-DD' (mặc định hôm nay), storeId (bắt buộc nếu cần ghi tác giả), tags:[] }
 */
export function mdToPlaybook(md, slug, opts = {}) {
  if (!slug) throw new Error('Thiếu slug.');
  const { h1, intro, sections } = splitMd(md);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const entries = [...(intro ? [{ title: 'Tổng quan', body: intro }] : []), ...sections].filter((s) => s.body);
  if (!entries.length) throw new Error('Tệp md không có mục `## ` nào có nội dung.');
  const name = nameOf(h1, slug);
  const when = `Agent nhận việc thuộc mảng ${name}`;
  const groups = entries.map((e, i) => ({ id: `g${i + 1}`, title: e.title }));
  const nodes = entries.map((e, i) => ({
    id: `e${i + 1}`, type: 'entry', group: `g${i + 1}`, label: e.title, detail: e.body,
    x: { asks: [...new Set([lower(e.title), `${words(slug)} ${lower(e.title)}`])], when, verified_at: today },
  }));
  return {
    meta: {
      id: `playbook-${slug}`, kind: 'knowledge', title: `Playbook nhân viên AI · ${name}`,
      summary: `Tri thức mảng ${name} cho agent: ${entries.map((e) => e.title).join(' · ')}. Bản nạp từ ${slug}.md (${today}).`,
      authority: 'source', status: 'draft', tags: ['staff-playbook', slug, ...(opts.tags ?? [])], author: opts.storeId != null ? { store_id: opts.storeId } : {}, revision: 1,
    },
    groups, nodes,
  };
}

/** Bản lưu cho playbook ĐÃ CÓ: giữ status/revision/authority hiện tại (không tự công bố, không hạ bản đã duyệt). */
export function forUpdate(next, existingMeta = {}) {
  const keep = {};
  for (const k of ['status', 'authority', 'revision']) if (existingMeta[k] !== undefined) keep[k] = existingMeta[k];
  return { ...next, meta: { ...next.meta, ...keep } };
}

/** Tóm tắt cho --dry: số mục + kích thước từng mục. */
export function summarize(pb) {
  const sizes = pb.nodes.map((n) => ({ id: n.id, label: n.label, bytes: Buffer.byteLength(n.detail, 'utf8') }));
  return { id: pb.meta.id, entries: pb.nodes.length, bytes: sizes.reduce((a, s) => a + s.bytes, 0), sizes };
}

const normLabel = (s) => lower(String(s ?? '')).slice(0, 40);
const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

/**
 * #756 — cảnh báo ghi đè: so bản ONLINE đang có (playbook JSON lấy từ get) với bản sắp đẩy theo từng mục.
 * - 'bigger': mục online LỚN HƠN mục sắp đẩy quá `tolerance` byte (nghi đẩy nhầm bản kho cũ ⇒ mất chữ — vd Nhật ký học).
 * - 'missing': mục online không còn trong bản sắp đẩy (khớp theo tiêu đề đã bỏ phần trong ngoặc).
 * Hàm THUẦN. Server thay vài từ (vd "wrangler" → "cli") nên online hay NGẮN hơn chút — dung sai mặc định 16 byte.
 */
export function overwriteWarnings(onlinePb, nextPb, { tolerance = 16 } = {}) {
  const out = [];
  const nextBy = new Map((nextPb?.nodes ?? []).map((n) => [normLabel(n.label), n]));
  for (const o of onlinePb?.nodes ?? []) {
    const n = nextBy.get(normLabel(o.label));
    if (!n) { out.push({ kind: 'missing', label: o.label, online: bytes(o.detail), next: 0 }); continue; }
    const ob = bytes(o.detail); const nb = bytes(n.detail);
    if (ob > nb + tolerance) out.push({ kind: 'bigger', label: o.label, online: ob, next: nb });
  }
  return out;
}

/** 1 dòng/cảnh báo, dùng cho in ra màn hình. */
export function fmtWarning(w) {
  return w.kind === 'missing'
    ? `⚠️ mục online "${w.label}" (${w.online}B) KHÔNG có trong bản sắp đẩy — sẽ MẤT`
    : `⚠️ mục "${w.label}": online ${w.online}B > sắp đẩy ${w.next}B — sẽ bị ghi đè bằng bản NGẮN hơn`;
}

/**
 * Đồng bộ 1 playbook lên dbio qua MCP `ai_playbook` (call = (args) => Promise<json>).
 * Chưa có (theo slug trong `list`) ⇒ create; đã có ⇒ get lấy digest + meta rồi save kèm base_digest (KHÔNG ghi mù).
 * Trả { action:'created'|'updated'|'blocked', profile_id, entries, warnings? } — 'blocked' = có cảnh báo ghi đè và không --force (KHÔNG save).
 */
export async function syncPlaybook(call, pb, { force = false } = {}) {
  const slug = pb.meta.id;
  const hit = ((await call({ action: 'list' })).playbooks ?? []).find((p) => p.slug === slug || p.id === slug);
  if (!hit) {
    const r = await call({ action: 'create', slug, playbook: pb });
    return { action: 'created', profile_id: r.profile_id, entries: pb.nodes.length };
  }
  const cur = await call({ action: 'get', profile_id: hit.profile_id, view: 'full' });
  if (!cur.digest) throw new Error(`get ${hit.profile_id} không trả digest — không lưu mù.`);
  const warnings = overwriteWarnings(cur.playbook, pb);
  if (warnings.length && !force) return { action: 'blocked', profile_id: hit.profile_id, entries: pb.nodes.length, warnings }; // #756: không ghi mù đè bản online lớn hơn
  await call({ action: 'save', profile_id: hit.profile_id, base_digest: cur.digest, playbook: forUpdate(pb, cur.playbook?.meta) });
  return { action: 'updated', profile_id: hit.profile_id, entries: pb.nodes.length, ...(warnings.length ? { warnings } : {}) };
}
