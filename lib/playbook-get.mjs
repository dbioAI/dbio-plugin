/**
 * lib/playbook-get.mjs — phần THUẦN (client giả, không IO ngoài hàm truyền vào; có test) của `dbio playbook get` (#806):
 * ĐỌC ONLINE qua MCP `ai_playbook` (nguồn chuẩn, slug `playbook-<slug>`), rơi về kho `playbooks/<slug>.md` + cảnh báo 1 dòng khi online hỏng.
 * Token: dàn ý = get KHÔNG view (nodes, không nội dung); một mục = view "text" + section (id nhóm gN); cả bài = view "text". KHÔNG dùng view full/JSON để nạp.
 */
export const onlineSlugOf = (slug) => `playbook-${String(slug).replace(/\.md$/, '')}`;

/** Tách theo dòng bắt đầu bằng "## " (bỏ qua trong khối ```). Dùng cho bản KHO. */
export function sections(text) {
  const lines = text.split('\n'); const out = []; let cur = { title: '(đầu tệp)', start: 0, lines: [] }; let fence = false;
  lines.forEach((l, i) => {
    if (l.startsWith('```')) fence = !fence;
    if (!fence && /^## /.test(l)) { out.push(cur); cur = { title: l.slice(3).trim(), start: i, lines: [] }; }
    cur.lines.push(l);
  });
  out.push(cur);
  return out;
}

/** Hiển thị bản KHO: dàn ý (số dòng) | --section | --full. Lỗi người dùng ⇒ ném Error. */
export function renderLocal(text, slug, { section, full } = {}) {
  if (full) return [text.trimEnd()];
  const secs = sections(text);
  if (section) {
    const q = String(section).toLowerCase();
    const hit = secs.filter((s) => s.title.toLowerCase().includes(q));
    if (!hit.length) throw new Error(`Không có mục chứa "${section}". Mục: ${secs.slice(1).map((s) => s.title).join(' | ')}`);
    return [hit.map((s) => s.lines.join('\n').trimEnd()).join('\n\n')];
  }
  return [`${slug} — ${text.split('\n').length} dòng · ${secs.length - 1} mục (dùng --section "<từ khoá>" hoặc --full)`, ...secs.slice(1).map((s) => `  ## ${s.title} (${s.lines.length} dòng)`)];
}

/** Lý do ngắn, nói rõ nguồn lỗi: thiếu khoá / không có quyền (scope) / mạng / từ chối. */
export function reasonOf(err, keyStatus = 'ok') {
  if (keyStatus === 'missing') return 'không có khoá nhân viên trên máy này';
  if (keyStatus === 'broken') return 'tệp khoá hỏng';
  const m = String(err?.message ?? err ?? '');
  if (err?.auth || /HTTP 40[13]|bị từ chối \(HTTP/.test(m)) return 'khoá bị từ chối (thiếu scope hoặc hết hạn)';
  if (/forbidden|scope|permission|quyền/i.test(`${err?.code ?? ''} ${m}`)) return `ai_playbook từ chối (${String(err?.code ?? m).slice(0, 60)})`;
  if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|timeout|aborted|network|HTTP 5\d\d/i.test(m) || err?.name === 'TimeoutError') return `lỗi mạng (${m.slice(0, 60)})`;
  return m.slice(0, 80) || 'lỗi không rõ';
}

const labelOf = (n) => String(n.label ?? '').trim();

/** Từ outline online (nodes + groups) tìm group id theo từ khoá nhãn (không phân biệt hoa thường). */
export function pickSections(outline, keyword) {
  const q = String(keyword).toLowerCase();
  const groupOf = new Map((outline.groups ?? []).map((g) => [g.title, g.id]));
  return (outline.nodes ?? []).filter((n) => labelOf(n).toLowerCase().includes(q)).map((n) => ({ label: labelOf(n), group: n.group ?? groupOf.get(labelOf(n)) }));
}

/** Phần thân từ dòng "## " đầu tiên (bỏ tiêu đề + tóm tắt đầu bài mà view text luôn kèm). */
export const bodyFromText = (text) => { const t = String(text ?? ''); const i = t.startsWith('## ') ? 0 : t.indexOf('\n## '); return (i < 0 ? t : t.slice(i === 0 ? 0 : i + 1)).trimEnd(); };

/**
 * Đọc ONLINE. api = { outline(slug) → get không view, text(slug, groupId?) → get view:text [+section] }.
 * Trả mảng dòng; ném lỗi (mạng/từ chối) hoặc Error có .userError=true (từ khoá mục không có).
 */
export async function readOnline(api, slug, { section, full } = {}) {
  const os = onlineSlugOf(slug);
  if (full) { const r = await api.text(os); return [`(online) ${slug} · digest ${String(r.digest ?? '').slice(7, 19)}`, String(r.text ?? '').trimEnd()]; }
  const o = await api.outline(os);
  const nodes = o.nodes ?? [];
  if (!section) return [`(online) ${slug} — ${nodes.length} mục · digest ${String(o.digest ?? '').slice(7, 19)} (dùng --section "<từ khoá>" hoặc --full)`, ...nodes.map((n) => `  ## ${labelOf(n)}`)];
  const hit = pickSections(o, section).filter((h) => h.group);
  if (!hit.length) { const e = new Error(`Không có mục chứa "${section}". Mục: ${nodes.map(labelOf).join(' | ')}`); e.userError = true; throw e; }
  const parts = [];
  for (const h of hit) parts.push(bodyFromText((await api.text(os, h.group)).text));
  return [`(online) ${slug} · ${hit.map((h) => h.label).join(' + ')}`, parts.join('\n\n')];
}

/**
 * Quyết định NGUỒN. mode: 'auto' (online, hỏng ⇒ kho + cảnh báo) | 'online' (hỏng ⇒ lỗi, không rơi kho) | 'local' (chỉ kho).
 * deps = { keyStatus(): 'ok'|'missing'|'broken', api(): client giả|thật, readLocalText(): string (ném nếu không có) }.
 * Trả { lines, source: 'online'|'local', warning?: string, code: 0|1 }. Không bao giờ ném (lỗi ⇒ code 1, lines = thông báo).
 */
export async function getPlaybook(slug, opts, deps, mode = 'auto') {
  const fromLocal = (warning) => {
    try { return { source: 'local', warning, code: 0, lines: renderLocal(deps.readLocalText(), slug, opts) }; }
    catch (e) { return { source: 'local', warning, code: 1, lines: [e.message] }; }
  };
  if (mode === 'local') return fromLocal(undefined);
  let reason;
  const ks = deps.keyStatus();
  if (ks !== 'ok') reason = reasonOf(null, ks);
  else {
    try { return { source: 'online', code: 0, lines: await readOnline(deps.api(), slug, opts) }; }
    catch (e) {
      if (e?.userError) return { source: 'online', code: 1, lines: [e.message] };
      reason = reasonOf(e);
    }
  }
  if (mode === 'online') return { source: 'online', code: 1, lines: [`✖ online không đọc được: ${reason}`] };
  return fromLocal(`⚠️ đọc bản KHO (dự phòng): ${reason}`);
}

/** Kiểm GỌI ĐƯỢC ai_playbook (cho preflight): 1 lệnh nhẹ list limit 1. Trả {ok, reason?}. Không ném. */
export async function probeAiPlaybook(keyStatus, call) {
  if (keyStatus !== 'ok') return { ok: false, reason: reasonOf(null, keyStatus) };
  try { await call('ai_playbook', { action: 'list', limit: 1 }); return { ok: true }; } catch (e) { return { ok: false, reason: reasonOf(e) }; }
}
