/**
 * lib/staff-logic.mjs — phần THUẦN (không IO, không mạng; có test) của `dbio staff done|accept|assign|inbox`, `dbio check`, `dbio hr checkin` (#704).
 */
import { pmName } from './common.mjs';

/** Tên (nhân viên / tiêu đề phiên) so khớp được: gộp khoảng trắng, bỏ đầu-cuối, hạ chữ thường. Dùng chung check · hr. */
export const normName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
export const sameName = (a, b) => normName(a) === normName(b);

/** Mã thẻ DẠNG ĐẦY ĐỦ `<board>#<thẻ>` — cổng khoá lead chỉ dò được nhóm của thẻ khi có board (số trần ⇒ not_yours). "#704" / "1001#704" / 704 đều ⇒ "1001#704". */
export function taskRef(board, id) {
  const n = Number(String(id ?? '').replace(/^#/, '').split('#').pop());
  if (!Number.isInteger(n) || n <= 0) throw new Error('Sai mã thẻ.');
  const b = Number(board);
  if (!Number.isInteger(b) || b <= 0) throw new Error('Sai mã sổ cái (board).');
  return `${b}#${n}`;
}

export const REASON_LEVELS = ['ok', 'review', 'blocked', 'done'];

/**
 * Tham số `approval_reason` cho `staff done`: {level, text, proposal?, result?(chỉ level done)}.
 * in: {level?, state, proof?, debt?, proposal?}. Mức lạ ⇒ ném lỗi (không đoán).
 */
export function buildReason({ level, state, proof, debt, proposal, deliverables } = {}) {
  const lv = String(level === true || level == null || level === '' ? 'ok' : level).toLowerCase();
  if (!REASON_LEVELS.includes(lv)) throw new Error(`--level phải là ${REASON_LEVELS.join('|')}.`);
  const text = String(state ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Thiếu nội dung lý do (--state).');
  const out = { level: lv, text };
  if (proposal && proposal !== true) out.proposal = String(proposal).trim();
  // #809: kết quả 1 dòng cho mọi mức chủ XÁC NHẬN (ok / done) — ô "Bạn cần làm gì" hiện result này; máy chủ chặn vào Chờ duyệt khi thiếu.
  if (lv === 'done' || lv === 'ok') out.result = { summary: text, ...(proof ? { where: String(proof) } : {}), ...(debt ? { debt: String(debt) } : {}) };
  if (Array.isArray(deliverables) && deliverables.length) out.deliverables = deliverables; // #738 — vắng ⇒ server giữ danh sách cũ
  return out;
}

/** Tham số gọi MCP `ai_character approval_reason` (task LUÔN dạng đầy đủ). */
export const reasonArgs = (board, id, who, reason) => ({ task: taskRef(board, id), approval_reason: reason, ...(who ? { as: who } : {}) });

/** Cột Chờ duyệt? (so tên bỏ dấu cách thừa/hoa-thường). */
export const isApprovalColumn = (name) => normName(name) === 'chờ duyệt';

/** Danh sách @nhắc khi giao việc: người nhận, KHÔNG gồm chính người giao (tránh tin dội ngược vào hộp thư người giao — #679). */
export function assignMentions(to, assigner) {
  return sameName(to, assigner) ? [] : [to];
}

/**
 * #682 — phiên đang chạy của nhân viên khi có thể có NHIỀU phiên cùng tên.
 * in: mine = phiên local mang tên nhân viên (mới → cũ), sessionId/model = --session/--model, serverRef = runtime.session_ref trên server.
 * ra: {ses, dup, bad[], notes[], handled}
 *   - 1 phiên / có --session ⇒ như cũ (handled=false: so sánh serverRef do nơi gọi làm).
 *   - >1 phiên: phiên hiện hành = --session hoặc phiên mới nhất; nếu nó === serverRef ⇒ ✓ + ghi chú phiên trùng; khác ⇒ LỆCH "không giữ vai".
 */
export function evaluateSession(mine, { sessionId, model, serverRef } = {}) {
  const list = mine ?? [];
  const found = sessionId ? list.find((s) => s.id === sessionId) : null;
  const ses = sessionId ? (found ?? { id: sessionId, model }) : list[0];
  const dup = list.length;
  const bad = []; const notes = [];
  if (!dup) return { ses: ses ?? null, dup, bad: ['no_session'], notes, handled: false }; // không có phiên local mang tên (kể cả khi có --session) ⇒ báo như cũ
  if (dup <= 1) return { ses, dup, bad, notes, handled: false };
  const tail = (x) => `…${String(x ?? '-').slice(-8)}`;
  if (serverRef && ses.id === serverRef) {
    notes.push(`có ${dup} phiên trùng tên — đóng/đổi tên phiên thừa`);
    return { ses, dup, bad, notes, handled: true };
  }
  if (serverRef && list.some((s) => s.id === serverRef)) {
    bad.push(`phiên này không giữ vai (server giữ ${tail(serverRef)}; có ${dup} phiên trùng tên — đóng/đổi tên phiên thừa)`);
    return { ses, dup, bad, notes, handled: true };
  }
  // server không giữ phiên nào trong số phiên cùng tên (vắng/khác máy) ⇒ để luật so serverRef thường xử lý
  notes.push(`có ${dup} phiên trùng tên — đóng/đổi tên phiên thừa`);
  return { ses, dup, bad, notes, handled: false };
}

/** Cách dùng cây origin của `dbio deploy`: lệnh CHỈ-ĐỌC (done/verify) và cây đã có sẵn ⇒ dùng thẳng, KHÔNG lấy khoá, KHÔNG checkout (#675). */
export const treeMode = ({ readOnly, treeExists, hasNodeModules }) => (readOnly && treeExists && hasNodeModules ? 'readonly' : 'locked');

/**
 * #736 THUÊ TRI THỨC — tham số `ai_character knowledge_hire` cho `dbio staff hire <thẻ> --character "<tên>" [--model m]`.
 * task LUÔN dạng đầy đủ; thiếu / rỗng character ⇒ ném lỗi; model `true` (cờ không giá trị) ⇒ bỏ.
 */
export function hireArgs(board, id, who, character, model) {
  const ch = character === true ? '' : String(character ?? '').replace(/\s+/g, ' ').trim();
  if (!ch) throw new Error('Thiếu --character "<tên nhân viên được thuê tri thức>".');
  const m = model === true || model == null ? '' : String(model).trim();
  return { task: taskRef(board, id), character: ch, ...(m ? { model: m } : {}), ...(who ? { as: who } : {}) };
}

/** Tỉ lệ 0..1 ⇒ "80%"; null ⇒ "—". */
const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Math.round(Number(v) * 100)}%`);

/** Một dòng số của nhân vật: "<tên>: N (7 ngày) · tổng M · đạt lần đầu P% · lần cuối <thẻ>". */
export function hireStatsLine(name, s = {}) {
  return `${name ?? '?'}: ${s?.d7 ?? 0} (7 ngày) · tổng ${s?.total ?? 0} · đạt lần đầu ${pct(s?.first_pass_rate)}${s?.last_task ? ` · lần cuối ${s.last_task}` : ''}`;
}

/** Kết quả `knowledge_hire` ⇒ ĐÚNG 2 dòng (ghi gì · số của nhân vật). */
export function formatHire(r) {
  const name = r?.character?.name ?? '?';
  return [
    `ok ${r?.task ?? '?'} · thuê tri thức ${name}${r?.hire?.model ? ` (${r.hire.model})` : ''} · ${r?.counted ? 'đã tính +1' : 'đã có — không cộng thêm'}`,
    hireStatsLine(name, r?.stats),
  ].join('\n');
}

// ---- #738 BÀN GIAO CÓ KIỂU: `dbio staff done … --out <type>=<giá trị>[|<tiêu đề>[|<thêm>]]` (lặp nhiều lần) ----------------------------
export const OUT_TYPES = ['url', 'image', 'video', 'text', 'web', 'code', 'file'];
/** Cờ thoát hiểm khi việc có mã nhưng THẬT SỰ không có sản phẩm để xem (refactor, test, hạ tầng): `--no-deliverable "<lý do>"`. */
export const NO_OUT_FLAG = 'no-deliverable';
/** Một dòng hướng dẫn khi thiếu --out. */
export const OUT_HINT = 'Thiếu sản phẩm bàn giao XEM ĐƯỢC (luật phòng mục 0 = chặn, #809): thêm --out image=<ảnh.png>|<tiêu đề> (lặp được; url= · video= · web=<link>|<tiêu đề>|<ảnh1,ảnh2> · file=) — code / text KHÔNG tính. Cần chủ chọn hướng mà không có gì để xem ⇒ --level review --proposal "..." (--no-deliverable chỉ dùng với review / blocked).';
/** #809: kiểu --out chủ XEM được tại chỗ (cùng luật máy chủ done-proof.ts VIEWABLE_DELIVERABLE_TYPES). */
export const VIEWABLE_OUT_TYPES = new Set(['image', 'video', 'url', 'web', 'file']);

/** Kho media của store chưa nhận PDF (upload-stream trả 400 "application/pdf not allowed") — PDF chỉ đưa bằng link https. */
export const PDF_HINT = 'kho chưa nhận PDF — đưa link https (url=/file=https://…pdf) hoặc dùng ảnh';

/** Link web công khai (https://…)? — còn lại coi là tệp trên máy cần tải lên kho. */
export const isHttps = (v) => /^https:\/\/\S+$/i.test(String(v ?? '').trim());

/**
 * Phân tích MỘT `--out`: "<type>=<value>[|<title>[|<extra>]]". extra: web ⇒ ảnh chụp (phẩy) · video ⇒ ảnh poster · image ⇒ "390" / "1440,dark" (độ rộng, sáng/tối).
 * `code` không giá trị ⇒ để nơi gọi điền repo@sha từ git. Sai ⇒ ném lỗi (không đoán).
 */
export function parseOut(spec) {
  const s = String(spec ?? '').trim();
  const eq = s.indexOf('=');
  const type = (eq < 0 ? s : s.slice(0, eq)).trim().toLowerCase();
  if (!OUT_TYPES.includes(type)) throw new Error(`--out "${s.slice(0, 40)}": kiểu phải là ${OUT_TYPES.join('|')} (vd --out image=shot.png|Popup 390)`);
  const rest = eq < 0 ? '' : s.slice(eq + 1);
  // text được chứa "|"? — không: dấu | là ngăn cách; nội dung dài dùng tệp .txt (file=) hoặc trang tài liệu (url=).
  const [value = '', title = '', extra = ''] = rest.split('|').map((x) => x.trim());
  if (!value && type !== 'code') throw new Error(`--out ${type}= thiếu giá trị`);
  const o = { type, value, title: title || null, extra: extra || null };
  // PDF TRÊN MÁY ⇒ lỗi rõ 1 dòng ngay (thay vì mint vé rồi PUT bị 400); link https …pdf vẫn nhận.
  const pdf = localFilesOf(o).find((f) => /\.pdf$/i.test(f.trim()));
  if (pdf) throw new Error(`--out ${type}=${pdf}: ${PDF_HINT}`);
  return o;
}

/** Các tệp TRÊN MÁY của một --out cần tải lên kho trước (giá trị không phải https). */
export function localFilesOf(o) {
  const files = [];
  if (['image', 'video', 'file'].includes(o.type) && !isHttps(o.value)) files.push(o.value);
  if (o.type === 'web' && o.extra) for (const p of o.extra.split(',').map((x) => x.trim()).filter(Boolean)) if (!isHttps(p)) files.push(p);
  if (o.type === 'video' && o.extra && !isHttps(o.extra)) files.push(o.extra);
  return files;
}

/** --out đã phân tích + bảng tệp đã tải (đường dẫn máy ⇒ link https) + git (cho code) ⇒ một mục deliverables cho server. */
export function toDeliverable(o, uploaded = {}, git = null) {
  const u = (p) => (isHttps(p) ? p : uploaded[p] ?? p); // chưa tải ⇒ để nguyên: server từ chối đường dẫn máy (không lọt im lặng)
  const d = { type: o.type, ...(o.title ? { title: o.title } : {}), value: o.type === 'text' ? o.value : u(o.value) };
  if (o.type === 'image' && o.extra) {
    const meta = {};
    for (const t of o.extra.split(',').map((x) => x.trim().toLowerCase())) {
      if (/^\d{2,5}$/.test(t)) meta.width = Number(t);
      else if (t === 'dark' || t === 'light' || t === 'tối' || t === 'sáng') meta.theme = t === 'tối' ? 'dark' : t === 'sáng' ? 'light' : t;
    }
    if (Object.keys(meta).length) d.meta = meta;
  }
  if (o.type === 'web' && o.extra) d.meta = { shots: o.extra.split(',').map((x) => x.trim()).filter(Boolean).map(u) };
  if (o.type === 'video' && o.extra) d.meta = { poster: u(o.extra) };
  if (o.type === 'url' && o.extra) d.meta = { env: o.extra };
  if (o.type === 'code') {
    if (!o.value) {
      if (!git?.head) throw new Error('--out code không kèm giá trị cần chạy trong worktree (hoặc ghi --out code=<repo>@<sha>).');
      d.value = `${git.repo}@${git.head}`;
      d.meta = { ...(git.branch ? { branch: git.branch } : {}) };
    }
    if (o.extra) d.meta = { ...(d.meta ?? {}), live: o.extra };
  }
  return d;
}

/** Một dòng CẢNH BÁO (chế độ mặc định, chưa chặn) khi thiếu --out. */
export const OUT_WARN = 'Cảnh báo: thiếu --out xem được (image / video / url / web / file) — cổng đang TẮT (DBIO_DONE_REQUIRE_OUT=0) nên vẫn chạy, nhưng máy chủ vẫn chặn vào Chờ duyệt khi nhóm đặt done_proof = block.';

/** Cổng --out đang BẬT (từ chối)? Biến môi trường DBIO_DONE_REQUIRE_OUT (1/true/on bật · 0/false/off tắt, thắng cấu hình) ⇒ khoá config/release.json staff.done_require_out ⇒ #809 mặc định BẬT (luật phòng mục 0 = chặn). */
export function requireOutOn(env = {}, cfg = {}) {
  const e = String(env?.DBIO_DONE_REQUIRE_OUT ?? '').trim().toLowerCase();
  if (e) return !['0', 'false', 'off', 'no'].includes(e);
  return cfg?.staff?.done_require_out !== false;
}

/**
 * Cổng "báo xong phải có sản phẩm" (#809: mọi lần báo xong mức ok / done, CẢ việc không có mã): cần ≥1 --out XEM ĐƯỢC (image / video /
 * url / web / file — code, text không tính). review / blocked (chủ chọn hướng / gỡ kẹt) ⇒ không cần. --no-deliverable "<lý do>" chỉ
 * nhận với review / blocked; mức ok / done ⇒ vẫn thiếu. Trả { error, warn }: require ⇒ error · tắt ⇒ warn.
 * --no-deliverable không kèm lý do ⇒ luôn error (lỗi dùng cờ).
 */
export function outGate({ level, outs = [], noDeliverable, require = true } = {}) {
  if (noDeliverable === true || (noDeliverable != null && !String(noDeliverable).trim())) return { error: '--no-deliverable cần lý do: --no-deliverable "<vì sao không có gì để xem>".', warn: null };
  const lv = String(level === true || level == null || level === '' ? 'ok' : level).toLowerCase();
  if (lv === 'review' || lv === 'blocked') return { error: null, warn: null };
  if (outs.some((o) => VIEWABLE_OUT_TYPES.has(o.type))) return { error: null, warn: null };
  return require ? { error: OUT_HINT, warn: null } : { error: null, warn: OUT_WARN };
}

/** Dòng "6. Xem:" của bình luận báo xong — mỗi sản phẩm `kiểu tiêu đề → link` (text: 60 ký tự đầu). */
export function outLine(list) {
  if (!list.length) return null;
  return list.map((d) => `${d.type}${d.title ? ` ${d.title}` : ''} → ${d.type === 'text' ? `"${String(d.value).replace(/\s+/g, ' ').slice(0, 60)}"` : d.value}`).join(' · ');
}

/** Phản hồi PUT /media-direct (media row, có thể bọc {success,data}) ⇒ link https; không có ⇒ null. */
export function mediaUrlOf(r) {
  const cand = [r?.data?.url, r?.url, r?.result?.url, r?.data?.media?.url, r?.media?.url];
  return cand.find((x) => isHttps(x)) ?? null;
}

/**
 * #828 — thẻ GÓP Ý: ở cột Đang trao đổi, nhãn `gop-y`, bóng phía CHỦ (server: `discuss` do nhân viên gọi ⇒ ball human ⇒ PM không bị đánh thức).
 * urgent ⇒ thêm nhãn `khan` + @<PM> và một bình luận @nhắc để PM thức (watch-filter coi chữ KHẨN là khẩn).
 */
export const GOP_Y_LABEL = 'gop-y';
export const GOP_Y_URGENT_LABEL = 'khan';
export function proposeSpec({ title, body, urgent = false, who, now, pm = pmName() }) {
  const head = `**Góp ý${urgent ? ' KHẨN' : ''}** (từ ${who}, ${now})`;
  return {
    title: `Góp ý: ${title}`,
    description: `${head}

${body ?? '(chưa có mô tả)'}`,
    labels: urgent ? [GOP_Y_LABEL, GOP_Y_URGENT_LABEL, `@${pm}`] : [GOP_Y_LABEL],
    wakeNote: urgent ? `🚨 KHẨN @${pm}: ${title} — cần ${pm} xử lý (góp ý từ ${who}).` : null,
    pm,
  };
}
