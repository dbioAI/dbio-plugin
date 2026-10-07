#!/usr/bin/env node
/**
 * dbio staff — MỘT lệnh cho mọi giao tiếp của nhân viên AI với sổ cái dbio, KHÔNG qua MCP connector.
 * Gọi thẳng HTTP tới MCP server bằng KHOÁ RIÊNG của nhân viên (%USERPROFILE%\.dbio\staff-keys\<tên>.json, tạo bằng
 * `dbio hr key "<tên>"`). Không bao giờ in khoá. Đầu ra GỌN (tiết kiệm token); `--full` để đủ.
 *
 *   dbio staff --as "<tên nhân viên>" <lệnh> [...]            (hoặc đặt biến môi trường DBIO_STAFF)
 *
 *   whoami                              kiểm khoá + nhịp sống ⇒ 1 dòng
 *   card <id> [--n 5] [--full]          thẻ gọn: tiêu đề · cột · hồ sơ làm việc mới nhất · n bình luận cuối
 *   checkpoint <id> --next "..." [--wait "..."] [--deploy "..."] [--mig "..."] [--dir <worktree>] [--dry]
 *                                       tự thu git (worktree, nhánh, sha, đã push?, file dở) ⇒ ghi HỒ SƠ LÀM VIỆC lên thẻ
 *   takeover <id> [--dir <worktree>]    phiên kế nhận việc: in hồ sơ + ĐỐI CHIẾU với git cục bộ; lệch ⇒ thoát 3 (báo PM)
 *   say <id> "<nội dung>"               bình luận lên thẻ
 *   stuck <id> --kind env|permission|tool|pm|owner|context "<vì sao>" [--need "<cần gì>"] | --clear
 *   stuck <id> --partial [--kind owner|permission] "<việc chủ cần làm>" [--need "<cần gì>"] | --partial --clear  (#818 chờ chủ MỘT PHẦN — thẻ ở lại Đang làm)
 *                                       #744 KẸT có loại: work_state + staff_status + dòng KẸT cho người xem (server) · --clear = hết kẹt
 *   move <id> "<tên cột>"               chuyển cột
 *   new "<tiêu đề>" [--col "<cột>"] [--body "..."] [--labels a,b] [--prio 0-3] [--parent <thẻ cha>]    tạo thẻ (mặc định cột Nhận; 1 cấp cha–con)
 *   propose "<tiêu đề>" [--body "..."] [--urgent]  KÊNH GÓP Ý (#828): thẻ "Góp ý: …" ở cột ĐANG TRAO ĐỔI, nhãn gop-y, bóng phía CHỦ; PM không thức.
 *                                       --urgent (lỗi nghiêm trọng đang ảnh hưởng thật) ⇒ thêm nhãn khan + @PM + @nhắc ⇒ PM thức.
 *                                       Thấy thiếu script / bước lặp tay / luật tốn token ⇒ propose, KHÔNG tự làm, KHÔNG dừng việc đang làm
 *   assign <id> --to "<nhân viên>" [--brief "<≤12 dòng theo mẫu C>"] [--dry]
 *                                       PM giao thẻ CÓ SẴN: gắn nhãn @tên + cột Đã giao + bình luận brief @nhắc vào hộp thư
 *   assign --new "<tiêu đề>" --to "<nhân viên>" [--body "..."] [--prio 0-3]       thẻ mới qua staff_assign (có ACK/trạng thái)
 *   done <id> --state "..." --proof "..." --debt "..." --next "..." [--out <type>=<giá trị>[|tiêu đề[|thêm]]]... [--no-deliverable "<lý do>"] [--level ok|review|blocked|done] [--proposal "..."] [--no-code] [--close] [--dry] [--dir <worktree>]
 *                                       báo xong 5 dòng (trạng thái · sha · bằng chứng · nợ · việc kế) ⇒ thẻ sang Chờ duyệt;
 *                                       có mã mà CHƯA push / còn file dở ⇒ từ chối (dùng --no-code nếu việc không có mã).
 *                                       TRƯỚC khi chuyển cột tự ghi LÝ DO DUYỆT (ai_character approval_reason, task dạng đầy đủ <sổ cái>#<thẻ>, mức mặc định ok,
 *                                       text = --state; level done kèm result {summary,where,debt}) — chỉ người đang cầm thẻ ghi được, nên phải làm lúc này.
 *                                       #738 BÀN GIAO CÓ KIỂU: --out <type>=<giá trị>[|<tiêu đề>[|<thêm>]] LẶP được; type url|image|video|text|web|code|file.
 *                                         image=shot.png|Popup|390,dark · video=clip.mp4|Demo|poster.png · web=https://…|Trang|a-1440.png,a-390.png ·
 *                                         url=https://…|Dash|production · text=<nội dung>|Bài · file=ghi-chu.txt (PDF chỉ nhận dạng link: file=https://…/bao-cao.pdf) · code (tự thêm repo@sha khi có mã).
 *                                         Ảnh/video/tệp là đường dẫn MÁY ⇒ tự tải lên kho store (ai_character deliverable_upload ⇒ media-direct) rồi ghi link https.
 *                                         #809 (luật phòng mục 0 = chặn): mức ok / done PHẢI có ≥1 --out XEM ĐƯỢC (image / video / url / web / file — code, text
 *                                         không tính), kể cả --no-code; thiếu ⇒ TỪ CHỐI, thoát 1. --state = kết quả 1 dòng (result.summary, hiện trong ô "Bạn cần làm gì").
 *                                         Máy chủ cũng chặn vào Chờ duyệt (cài đặt nhóm done_proof). Tắt tạm cổng CLI: DBIO_DONE_REQUIRE_OUT=0.
 *                                         Không có gì để xem ⇒ --level review --proposal "..." (chủ chọn hướng); --no-deliverable "<lý do>" chỉ nhận với review / blocked.
 *                                       --close mà thẻ ĐÃ ở Chờ duyệt ⇒ vẫn đóng sang Xong (khoá member bị server từ chối ⇒ in "chờ người duyệt", thoát 0)
 *   accept <id> "<nhận xét>" [--dry]    cho PM/Trưởng nhóm nghiệm thu: approval_reason mức ok (dạng đầy đủ) + chuyển thẻ sang Xong; in 1 dòng
 *   hire <id> --character "<tên>" [--model <m>] [--dry]
 *                                       #736 PM/Trưởng nhóm ghi lần THUÊ TRI THỨC khi giao thẻ cho sub agent nạp playbook của người đó
 *                                       (ai_character knowledge_hire, task dạng đầy đủ). KHÔNG gắn nhãn / không đổi người phụ trách ⇒ ô nhân viên
 *                                       không nhảy Đang làm; cùng thẻ + người ghi lại không cộng. In 2 dòng: đã ghi gì · số 7 ngày/tổng/tỉ lệ đạt lần đầu
 *   hire --stats ["<tên>"]              đọc bộ đếm (knowledge_stats): một người ⇒ 2 dòng; không tên ⇒ mỗi người 1 dòng (tối đa 10)
 *   inbox [--all] [--ack-self]          hộp thư (mặc định chỉ chưa đọc); ẨN tin do chính mình gửi (#679), --ack-self tự đánh dấu đã đọc các tin đó
 *   ack <id...>                         đánh dấu đã xử lý
 *   reply <id> "<nội dung>"             trả lời người duyệt (staff_reply)
 *   status <state> [id] [--note "..."]  idle|working|waiting_owner|blocked (+ ghi máy/phiên/model vào runtime)
 *   watch [--max-min 115] [--fast 30] [--slow 60] [--rest 300] [--fresh]
 *                                       CANH TIN TỐI ƯU (#678): chỉ thức khi có việc CẦN QUYẾT; MỘT lệnh là đủ (không cần inbox/ack/card sau đó).
 *                                       Lọc 0 token + tự ack: tin do chính mình gửi · `decision` dội lại ≤2' sau khi mình move/done/assign thẻ đó · `decision` DUYỆT (#833, thẻ tự sang Xong) · trùng ≤60s.
 *                                       KHẨN (owner_reply/ping/request/assign/nudge/decision, @nhắc có ?/GO/kẹt, trao đổi chờ AI) ⇒ thức ngay.
 *                                       THƯỜNG (children_done, new_unassigned, ghi chú, báo cáo) ⇒ gom; thức khi ≥5 tin hoặc tin cũ nhất >20'.
 *                                       Thức ⇒ in mỗi tin ≤2 dòng (`<thẻ> · <ai> · <câu cần quyết>` + `↳ cột … · khẩn|thường`), TỰ ack đúng các tin đã in, thoát 0.
 *                                       BẢN SAO tin @nhắc giữa nhân viên (state 'copy' / copy_of) KHÔNG đánh thức: tự ack + chỉ đếm vào dòng tóm tắt; riêng THƯ KÝ thì đó là
 *                                       việc của nó (thường). Máy chủ báo direct_count=0 ⇒ không thức vì hộp thư. Vẫn đúng với máy chủ cũ (không có copy/direct).
 *                                       --fresh: lúc bắt đầu tự ack (không báo) mọi tin chưa đọc tạo TRƯỚC khi watch chạy + bỏ hàng đợi cũ ⇒ phiên mới không bị đánh thức bởi tin cũ.
 *                                       Hết giờ (mặc định 115' < trần 2h của app) ⇒ in ĐÚNG 1 dòng, thoát 3. Mỗi lần thoát ghi ~/.dbio/watch-log.jsonl (xem `dbio usage`).
 *                                       Nhịp (giây): fast = có trao đổi chờ AI / chủ vừa nhắn · slow = Trực bình thường · rest = chế độ Nghỉ (staff_pulse
 *                                       báo mode=rest — chờ BE #660; chưa có thì không bao giờ vào nhánh này)
 *   next [--take] [--all]               #745 THẺ KẾ TIẾP đã giao cho TÔI: cột "Đã giao", nhãn @tôi, ưu tiên cao trước, cũ trước ⇒ 1 dòng
 *                                       `#id [ưu tiên] tiêu đề` (kèm "còn n thẻ chờ" / cảnh báo đang làm dở) hoặc 'hết việc'. --all liệt kê cả hàng chờ.
 *                                       --take = nhận luôn: chuyển thẻ sang "Đang làm" + status working. Hết việc ⇒ thoát 3 (gợi ý: status idle + watch).
 *                                       Cuối thẻ: done → checkpoint → next → CÓ ⇒ làm tiếp thẻ đó (đọc card, brief trên thẻ) · HẾT ⇒ status idle + watch.
 *   sweep [--dry] [--full]              #745 QUÉT SỔ CÁI cho THƯ KÝ (0 token): thẻ Đã giao chưa ACK ⇒ ĐÁNH THỨC · thẻ Đang làm/Đã giao im >60' ⇒ HỎI · >120' ⇒ BÁO PM ·
 *                                       người cầm mất nhịp >10' ⇒ MẤT NHỊP · không có phiên ⇒ KHÔNG PHIÊN · 1 người ≥2 thẻ ⇒ 2 THẺ. Mỗi dòng: LOẠI #thẻ · tên → id phiên | nội dung.
 *                                       Ghi nhớ đã báo (1 lần / giờ / thẻ, ~/.dbio/secretary-nudged.json); --dry không ghi nhớ. Không ghi sổ cái, không nhắn phiên. Không việc ⇒ thoát 0 in "✓ …".
 *                                       `watch` của THƯ KÝ tự quét mỗi 15' (--sweep <phút>, 0 = tắt) và thức theo SỰ KIỆN: bản sao tin nhắc/giao việc/owner_assign ⇒ khẩn; gộp tin đến
 *                                       trong 20s thành 1 lần thức (--coalesce <giây>, 0 = in ngay) — thay cho thức định kỳ 55'.
 *   call <tool> '<json args>'           cửa thoát: gọi action bất kỳ, in JSON thô
 *
 * Tuỳ chọn chung: --board <id> (mặc định: khoá → DBIO_BOARD → thẻ đang cầm) · --model <id> · --session <id>
 * `checkpoint --dry` chỉ đọc git cục bộ — chạy được khi máy chưa có khoá.
 * Mã thoát: 0 ok · 1 lỗi server/đối số · 2 khoá sai/thiếu · 3 cần người (lệch hồ sơ / hết giờ chờ).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hostname } from 'node:os';
import { client, internalRoot, cut, die, git, gitFacts, helpOf, labelsOf, parseArgs, run, taskId, whoAmI } from '../../lib/common.mjs';
import { assignMentions, buildReason, formatHire, hireArgs, hireStatsLine, isApprovalColumn, localFilesOf, mediaUrlOf, outGate, outLine, parseOut, proposeSpec, reasonArgs, requireOutOn, taskRef, toDeliverable } from '../../lib/staff-logic.mjs';
import { COALESCE_MS, MAX_SHOW, coalesceGate, directGate, filterInbox, formatItem, isCopy, isGopYTalk, isSecretary, isSelf, pickBatch, shouldWake, taskIdOf } from '../../lib/watch-filter.mjs';
import { formatAction, formatNext, pickNext } from '../../lib/secretary.mjs';
import { runSweep } from '../../lib/secretary-io.mjs';
import { ackStale, fetchFreshItems } from '../../lib/watch-fetch.mjs';
import { endBeat, loadAssigned, loadQueue, loadSecretaries, loadSeen, loadTouched, logWatchExit, recordAssign, recordBeat, recordTouch, saveQueue, saveSeen } from '../../lib/watch-state.mjs';

const VALUE_FLAGS = ['--parent', '--n', '--next', '--wait', '--deploy', '--mig', '--dir', '--col', '--body', '--labels', '--prio', '--note',
  '--to', '--brief', '--new', '--state', '--proof', '--debt', '--max-min', '--fast', '--slow', '--rest', '--level', '--proposal', '--character', '--no-deliverable', '--kind', '--need', '--why', '--for', '--sweep', '--coalesce'];
const { flags, pos } = parseArgs(process.argv.slice(2), VALUE_FLAGS, ['--out']);
const [cmd, ...rest] = pos;
if (!cmd || flags.help) die(helpOf(import.meta.url), 0);


const WHO = whoAmI(flags);
const c = client(WHO, flags);
if (cmd !== 'whoami') await c.init(); // chốt sổ cái (flag/env/khoá/server) — không viết cứng
const { tb, ai, ref } = c;
const BOARD = c.board;
const CP_MARK = '📍 HỒ SƠ LÀM VIỆC';
const nowZ = () => `${new Date().toISOString().slice(0, 16)}Z`;

/** Hồ sơ mới nhất trên thẻ + các bình luận còn lại (đã bỏ hồ sơ). */
async function readCard(id) {
  // Server chưa có action lấy 1 thẻ ⇒ đọc cả board rồi lọc (đề xuất BE: task_get gọn). approval_view có cổng người duyệt nên không dùng.
  const [board, cl] = await Promise.all([tb('get'), tb('comment_list', { task_id: id, limit: 200 })]);
  const t = (board.data?.tasks ?? []).find((x) => Number(x.id) === id);
  if (!t) die(`Không thấy thẻ #${id} trên sổ cái ${BOARD}.`);
  const col = (board.data?.columns ?? []).find((x) => Number(x.id) === Number(t.column_id));
  const comments = cl.comments ?? [];
  const cp = [...comments].reverse().find((x) => String(x.body ?? '').startsWith(CP_MARK));
  return { t, col, comments, cp, columns: board.data?.columns ?? [] };
}

/**
 * #852: thẻ KHÁC (≠ id) đang ở cột Đang làm mà WHO cầm (nhãn @WHO). null = không đọc được (không cảnh báo bừa).
 * Chủ chốt 6/10: chờ chủ mà không còn việc khác ⇒ thẻ phải ở "Cần anh xử lý", không đứng mãi ở Đang làm.
 */
async function otherDoingCards(id) {
  try {
    const b = await tb('get');
    const doing = new Set((b.data?.columns ?? []).filter((c) => c.role === 'doing' || String(c.name ?? '').trim().toLowerCase() === 'đang làm').map((c) => Number(c.id)));
    const me = '@' + WHO.trim().toLowerCase();
    return (b.data?.tasks ?? []).filter((t) => Number(t.id) !== id && doing.has(Number(t.column_id)) && labelsOf(t.labels).some((l) => l.trim().toLowerCase() === me)).map((t) => Number(t.id));
  } catch { return null; }
}

/** Tên cột hiện tại của thẻ (task_get gọn; server chưa có ⇒ đọc cả board). */
async function columnOf(id) {
  try { const t = (await tb('task_get', { task_id: id, comments: 0, body_max: 0, description_max: 0 })).task; if (t) return t.column?.name ?? null; } catch { /* rơi về đọc board */ }
  return (await readCard(id)).col?.name ?? null;
}

const cmds = {
  async whoami() {
    const r = await ai('staff_pulse', { who: WHO });
    console.log(`ok ${WHO} · máy ${hostname()} · chưa đọc ${r.unread?.count ?? 0} · trao đổi chờ AI ${r.discuss_ai?.count ?? 0}`);
  },

  async card() {
    const id = taskId(rest[0]); const n = Number(flags.n ?? 5); const lim = flags.full ? 4000 : 400;
    // #658.1: task_get = MỘT thẻ gọn (có work_state). Server chưa có ⇒ rơi về đọc cả board.
    let got = null;
    try { got = (await tb('task_get', { task_id: id, comments: n, body_max: lim, description_max: flags.full ? 6000 : 800 })).task ?? null; } catch { got = null; }
    if (got) {
      console.log(`#${id} ${got.title ?? ''}\ncột: ${got.column?.name ?? got.column?.id ?? '?'} · ưu tiên ${got.priority ?? '?'} · nhãn ${(got.labels ?? []).join(',') || '-'}${got.by ? ` · bởi ${got.by}` : ''}`);
      if (got.description) console.log(`mô tả: ${cut(got.description, flags.full ? 6000 : 800)}`);
      const ws = got.work_state;
      if (ws) {
        const l1 = [ws.stage && `giai đoạn ${ws.stage}`, ws.branch && `nhánh ${ws.branch}`, ws.head && `head ${String(ws.head).slice(0, 7)}`, ws.pushed != null && (ws.pushed ? 'ĐÃ push' : '⚠️ CHƯA push'), ws.dirty?.length && `⚠️ ${ws.dirty.length} file dở`, ws.worktree && `worktree ${ws.worktree}`, ws.machine && `máy ${ws.machine}`].filter(Boolean).join(' · ');
        const l2 = [ws.owner_hold?.waiting && `🟠 CHỜ CHỦ MỘT PHẦN: ${ws.owner_hold.waiting}${ws.owner_hold.need ? ` · cần: ${ws.owner_hold.need}` : ''} (${ws.owner_hold.at ?? '?'})`, ws.waiting && `chờ: ${ws.waiting}`, ws.migrations?.length && `migration: ${ws.migrations.join(', ')}`, ws.deploys?.length && `deploy: ${ws.deploys.join(', ')}`, ws.next && `kế tiếp: ${ws.next}`].filter(Boolean).join('\n');
        console.log(`--- work_state (${ws.at ?? '?'} · ${ws.by ?? '?'}) ---\n${l1}${l2 ? `\n${l2}` : ''}`);
      } else {
        // chưa có work_state ⇒ hồ sơ cũ dạng bình luận
        const cl = await tb('comment_list', { task_id: id, limit: 200 });
        const cpOld = [...(cl.comments ?? [])].reverse().find((x) => String(x.body ?? '').startsWith(CP_MARK));
        if (cpOld) console.log(`--- hồ sơ mới nhất (${cpOld.created_at}) ---\n${cpOld.body}`);
      }
      const cs = (got.comments ?? []).filter((x) => !String(x.body ?? '').startsWith(CP_MARK));
      if (cs.length) console.log(`--- ${cs.length} bình luận cuối ---`);
      for (const x of cs) console.log(`[${x.at}] ${x.by ?? '?'}: ${cut(x.body, lim)}`);
      return;
    }
    const { t, col, comments, cp } = await readCard(id);
    console.log(`#${id} ${t.title ?? ''}\ncột: ${col?.name ?? t.column_id ?? '?'} · ưu tiên ${t.priority ?? '?'} · nhãn ${labelsOf(t.labels).join(',') || '-'}`);
    if (t.description) console.log(`mô tả: ${cut(t.description, flags.full ? 6000 : 800)}`);
    if (cp) console.log(`--- hồ sơ mới nhất (${cp.created_at}) ---\n${cp.body}`);
    const tail = comments.filter((x) => x !== cp && !String(x.body ?? '').startsWith(CP_MARK)).slice(-n);
    if (tail.length) console.log(`--- ${tail.length}/${comments.length} bình luận cuối ---`);
    for (const x of tail) console.log(`[${x.created_at}] ${x.author_label ?? x.author_name ?? x.author_user_id ?? '?'}: ${cut(x.body, lim)}`);
  },

  async checkpoint() {
    const id = taskId(rest[0]);
    if (!flags.next) die('Thiếu --next "<bước kế tiếp>" (1–2 dòng).');
    const g = gitFacts(flags.dir ?? process.cwd());
    const lines = [`${CP_MARK} · ${WHO} · ${nowZ()}`, `- Máy: ${hostname()}${flags.session ? ` · phiên ${flags.session}` : ''}${flags.model ? ` · model ${flags.model}` : ''}`];
    if (g) {
      lines.push(`- Worktree: \`${g.top}\` · ${g.branch === 'HEAD' ? 'HEAD tách rời (detached)' : `nhánh \`${g.branch}\``} · gốc origin/main \`${g.base || '?'}\` (+${g.ahead || 0} commit)`);
      lines.push(`- Commit: \`${g.head}\` ${cut(g.subject, 90)} · ${g.onRemote.length ? `ĐÃ push (${g.onRemote.slice(0, 2).join(', ')})` : '⚠️ CHƯA push'}`);
      lines.push(g.dirty.length ? `- ⚠️ ${g.dirty.length} file sửa dở CHƯA commit: ${g.dirty.slice(0, 8).map((l) => l.slice(3)).join(', ')}${g.dirty.length > 8 ? ', …' : ''}` : '- Cây sạch (không có file dở)');
    } else lines.push('- (không ở trong git repo — không có thông tin mã)');
    if (flags.mig) lines.push(`- Migration: ${flags.mig}`);
    if (flags.deploy) lines.push(`- Deploy: ${flags.deploy}`);
    lines.push(`- Đang chờ: ${flags.wait ?? 'không'}`);
    lines.push(`- Bước kế tiếp: ${flags.next}`);
    const body = lines.join('\n');
    if (flags.dry) { console.log(body); return; }
    const r = await tb('comment_add', { task_id: id, body, audience: 'agent' }); // #744: hồ sơ làm việc = cho agent (tab Agent)
    // #658.4: ghi thêm work_state có cấu trúc (server chưa có ⇒ bỏ qua, bình luận ở trên vẫn là hồ sơ)
    let ws = '';
    try {
      await tb('checkpoint', { task_id: id, work_state: { machine: hostname(), ...(g ? { worktree: g.top, branch: g.branch, base: g.base, head: g.head, pushed: g.onRemote.length > 0, dirty: g.dirty.map((l) => l.slice(3)).slice(0, 30) } : {}), ...(flags.deploy ? { deploys: [flags.deploy] } : {}), ...(flags.mig ? { migrations: [flags.mig] } : {}), ...(flags.wait ? { waiting: flags.wait } : {}), next: flags.next } });
      ws = ' · work_state ✓';
    } catch { /* server cũ */ }
    console.log(`ok #${id} hồ sơ ${g?.head ?? '-'}${g && !g.onRemote.length ? ' (CHƯA push)' : ''}${g?.dirty.length ? ` · ${g.dirty.length} file dở` : ''} · comment ${r.comment_id}${ws}`);
  },

  async takeover() {
    const id = taskId(rest[0]);
    const { t, col, cp } = await readCard(id);
    console.log(`#${id} ${t.title ?? ''} · cột ${col?.name ?? '?'}`);
    if (!cp) { console.log('Chưa có hồ sơ làm việc trên thẻ — phiên trước chưa checkpoint. Báo PM trước khi làm.'); process.exit(3); }
    console.log(flags.full ? cp.body : cp.body.split('\n').filter((l) => /Bước kế tiếp|Đang chờ|Worktree|Commit/.test(l) || l.startsWith(CP_MARK)).join('\n'));
    // Đối chiếu hồ sơ ↔ máy này: worktree còn không, sha có trong git cục bộ không, cây có file dở không.
    const wt = /Worktree: `([^`]+)`/.exec(cp.body)?.[1];
    const sha = /Commit: `([0-9a-f]{7,40})`/.exec(cp.body)?.[1];
    const dir = flags.dir ?? wt;
    const problems = [];
    if (!dir || !existsSync(dir)) problems.push(`worktree "${dir ?? '?'}" không có trên máy này (phiên trước ở máy khác? dùng: dbio wt new ${id})`);
    else {
      const g = gitFacts(dir);
      if (!g) problems.push(`"${dir}" không phải git repo`);
      else {
        if (sha && !git(g.top, 'cat-file', '-t', sha)) problems.push(`commit ${sha} không có ở máy này (chưa push? chạy git fetch)`);
        else if (sha && !g.head.startsWith(sha.slice(0, 7))) problems.push(`HEAD hiện là ${g.head}, hồ sơ ghi ${sha.slice(0, 7)}`);
        if (g.dirty.length) problems.push(`${g.dirty.length} file sửa dở chưa commit trong cây hiện tại`);
      }
    }
    if (problems.length) { console.log(`⚠️ LỆCH: ${problems.join(' · ')} ⇒ báo PM, đừng tự làm tiếp.`); process.exit(3); }
    console.log('✓ khớp hồ sơ (worktree + commit + cây sạch) — làm tiếp được.');
  },

  async say() {
    const id = taskId(rest[0]); if (!rest[1]) die('Thiếu nội dung.');
    // #744: --for người|agent ⇒ audience (tab Người xem / Agent của popup thẻ); bỏ trống = server tự đoán (nhân viên AI ⇒ agent)
    const f = flags.for == null ? null : String(flags.for).toLowerCase();
    const audience = f == null ? null : /^(người|nguoi|human|chủ|chu)$/.test(f) ? 'human' : f === 'agent' ? 'agent' : die('--for phải là người | agent');
    const r = await tb('comment_add', { task_id: id, body: rest.slice(1).join(' '), ...(audience ? { audience } : {}) });
    console.log(`ok #${id} comment ${r.comment_id}${audience ? ` · cho ${audience === 'human' ? 'người' : 'agent'}` : ''}`);
  },

  async move() { const id = taskId(rest[0]); if (!rest[1]) die('Thiếu tên cột.'); await tb('task_move', { task_id: id, column_name: rest[1] }); recordTouch(WHO, id); console.log(`ok #${id} → ${rest[1]}`); },

  async new() {
    if (!rest[0]) die('Thiếu tiêu đề.');
    const board = await tb('get'); const cols = board.data?.columns ?? [];
    const want = String(flags.col ?? 'Nhận').toLowerCase();
    const col = cols.find((x) => String(x.name).toLowerCase() === want);
    if (!col) die(`Không thấy cột "${flags.col ?? 'Nhận'}" — có: ${cols.map((x) => x.name).join(' · ')}`);
    const labels = flags.labels ? String(flags.labels).split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (flags.dry) { console.log(`[dry] tạo thẻ "${rest[0]}" ở cột ${col.name}${labels.length ? ` nhãn ${labels.join(',')}` : ''}`); return; }
    const r = await tb('task_create', { column_id: col.id, title: rest[0], ...(flags.body ? { description: flags.body } : {}), ...(labels.length ? { labels } : {}), ...(flags.prio != null ? { priority: Number(flags.prio) } : {}), ...(flags.parent ? { parent: taskId(flags.parent) } : {}) });
    let pnote = '';
    if (flags.parent) { // #658.7: server cũ lặng lẽ bỏ qua trường lạ ⇒ kiểm lại bằng task_get
      try { const back = (await tb('task_get', { task_id: r.data?.id })).task; pnote = back?.parent?.id === taskId(flags.parent) ? ` · thuộc #${taskId(flags.parent)}` : ' · ⚠️ server CHƯA hỗ trợ thẻ cha (parent bị bỏ qua)'; } catch { pnote = ' · ⚠️ không kiểm được parent (server chưa có task_get)'; }
    }
    console.log(`ok #${r.data?.id ?? '?'} tạo ở cột ${col.name}${pnote}`);
  },

  async propose() {
    if (!rest[0]) die('Thiếu tiêu đề đề xuất.');
    const spec = proposeSpec({ title: rest[0], body: flags.body, urgent: !!flags.urgent, who: WHO, now: nowZ() });
    if (flags.dry) { console.log(`[dry] "${spec.title}" ⇒ cột Đang trao đổi · nhãn ${spec.labels.join(',')} · bóng phía chủ${spec.wakeNote ? ' · @nhắc PM' : ''}`); return; }
    const board = await tb('get');
    const col = (board.data?.columns ?? []).find((x) => String(x.name).toLowerCase() === 'đang trao đổi');
    if (!col) die('Không thấy cột Đang trao đổi.');
    const r = await tb('task_create', { column_id: col.id, title: spec.title, description: spec.description, labels: [...spec.labels, `@${WHO}`], priority: 0 }); // @tên = "thẻ mình cầm" ⇒ server cho gọi discuss (đặt bóng phía chủ)
    const id = r.data?.id;
    let ball = '';
    try { await ai('discuss', { task: taskRef(BOARD, id), as: WHO }); } catch (e) { ball = ` · ⚠️ chưa đặt được bóng phía chủ (${e?.message ?? e})`; } // thẻ đã ở đúng cột; discuss chỉ chốt "bóng"
    if (spec.wakeNote) await tb('comment_add', { task_id: id, body: spec.wakeNote, mentions_staff: [spec.pm] });
    console.log(`ok #${id ?? '?'} góp ý ở cột Đang trao đổi · nhãn ${spec.labels.join(',')}${spec.wakeNote ? ' · đã @nhắc PM (KHẨN)' : ' · PM không bị đánh thức'}${ball}`);
  },

  async assign() {
    const to = flags.to; if (!to) die('Thiếu --to "<nhân viên>".');
    if (flags.new) {
      if (flags.dry) { console.log(`[dry] staff_assign → ${to}: "${flags.new}"`); return; }
      const r = await ai('staff_assign', { as: WHO, to, title: flags.new, ...(flags.body ? { body: flags.body } : {}), ...(flags.prio != null ? { priority: Number(flags.prio) } : {}) });
      console.log(`ok giao "${cut(flags.new, 60)}" → ${to} · ${JSON.stringify(r.task ?? r.data ?? r.card ?? {}).slice(0, 120)}`);
      return;
    }
    const id = taskId(rest[0]);
    const { t, col, columns } = await readCard(id);
    const target = columns.find((x) => String(x.name).toLowerCase() === 'đã giao');
    if (!target) die('Không thấy cột Đã giao.');
    const tag = `@${to}`;
    const labels = [...new Set([...labelsOf(t.labels), tag])];
    const brief = flags.brief ?? '(không kèm brief — dùng mẫu C: Mục tiêu · Phạm vi · Điểm bắt đầu · Thao tác chung cần GO · Xong khi · Playbook)';
    if (flags.dry) { console.log(`[dry] #${id} ${col?.name ?? '?'} → Đã giao · nhãn ${tag} · nhắc ${to}\n${brief}`); return; }
    await tb('task_update', { task_id: id, labels });
    await tb('task_move', { task_id: id, column_id: target.id });
    const r = await tb('comment_add', { task_id: id, body: `📌 GIAO VIỆC → ${to} · ${WHO} · ${nowZ()}\n${brief}`, audience: 'agent', ...(assignMentions(to, WHO).length ? { mentions_staff: assignMentions(to, WHO) } : {}) }); // #679: không @nhắc chính người giao ⇒ tin không dội vào hộp thư người giao
    recordAssign(WHO, id); // #678: lọc mention/assign dội lại ≤2' (+ decision qua touched)
    console.log(`ok #${id} → Đã giao cho ${to} (comment ${r.comment_id}; trạng thái assigned_unacked CHƯA có — cần BE: staff_assign nhận task_id)`);
  },

  async done() {
    const id = taskId(rest[0]);
    for (const k of ['state', 'proof', 'debt', 'next']) if (!flags[k]) die(`Thiếu --${k} (báo xong đủ 5 dòng: trạng thái · sha · bằng chứng · nợ · việc kế).`);
    let shaLine; let g = null;
    if (flags['no-code']) shaLine = 'không có mã (việc không đụng repo)';
    else {
      g = gitFacts(flags.dir ?? process.cwd());
      if (!g) die('Không ở trong git repo — thêm --dir <worktree> hoặc --no-code nếu việc không có mã.');
      if (g.dirty.length) die(`Còn ${g.dirty.length} file sửa dở chưa commit (${g.dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}) — commit + push trước khi báo xong.`);
      if (!g.onRemote.length) die(`Commit ${g.head} CHƯA push — mã chưa push coi như mất. Push rồi báo lại.`);
      shaLine = `\`${g.head}\` ${cut(g.subject, 70)} (nhánh ${g.branch}, đã push)`;
    }
    // #738 BÀN GIAO CÓ KIỂU: --out <type>=<giá trị>[|tiêu đề[|thêm]] lặp được; việc có mã mà không có sản phẩm để xem ⇒ từ chối (trừ --no-deliverable "<lý do>").
    const noDl = flags['no-deliverable'];
    if (typeof noDl === 'string' && noDl.startsWith('--')) die('--no-deliverable cần lý do ngay sau: --no-deliverable "<vì sao không có gì để xem>".');
    let outs; try { outs = (flags.out ?? []).map(parseOut); } catch (e) { die(e.message); }
    // #809 MẶC ĐỊNH = TỪ CHỐI (luật phòng mục 0 = chặn); tắt tạm: DBIO_DONE_REQUIRE_OUT=0 hoặc config/release.json {"staff":{"done_require_out":false}} (máy chủ vẫn chặn theo done_proof của nhóm).
    let relCfg = {}; try { relCfg = JSON.parse(readFileSync(join(internalRoot() ?? '', 'config', 'release.json'), 'utf8').replace(/^﻿/, '')); } catch { /* không có cấu hình ⇒ mặc định */ }
    const gate = outGate({ level: flags.level, outs, noDeliverable: noDl, require: requireOutOn(process.env, relCfg) });   // #809: mọi báo xong ok/done
    if (gate.error) die(gate.error);
    if (gate.warn) console.error(gate.warn);
    if (g && !outs.some((o) => o.type === 'code')) outs.push({ type: 'code', value: '', title: null, extra: null }); // mã đã push ⇒ tự thêm repo@sha
    const repoName = g ? (git(g.top, 'config', '--get', 'remote.origin.url').split(/[\/:]/).pop() || basename(g.top)).replace(/\.git$/, '') : null; // tên repo thật (thư mục worktree là backend-t738)
    const gitInfo = g ? { repo: repoName, head: g.head, branch: g.branch } : null;
    const files = [...new Set(outs.flatMap(localFilesOf))];
    for (const f of files) if (!existsSync(f) || !statSync(f).isFile()) die(`--out: không thấy tệp "${f}" trên máy (ảnh/video/tệp phải là đường dẫn có thật hoặc link https).`);
    let reason; let deliverables;
    try { deliverables = outs.map((o) => toDeliverable(o, {}, gitInfo)); reason = buildReason({ level: flags.level, state: flags.state, proof: flags.proof, debt: flags.debt, proposal: flags.proposal, deliverables }); } catch (e) { die(e.message); }
    const body0 = [`✅ BÁO XONG · ${WHO} · ${nowZ()}`, `1. Trạng thái: ${flags.state}`, `2. Mã: ${shaLine}`, `3. Bằng chứng: ${flags.proof}`, `4. Nợ: ${flags.debt}`, `5. Việc kế: ${flags.next}`];
    const dest = flags.close ? 'Xong' : 'Chờ duyệt';
    if (flags.dry) { console.log(`[dry] → ${dest} · ${deliverables.length} sản phẩm${files.length ? ` (tải lên ${files.length}: ${files.map((f) => basename(f)).join(', ')})` : ''}\n${JSON.stringify(reasonArgs(BOARD, id, WHO, reason))}`); return; }
    // Tệp trên máy ⇒ vé tải 1-lần (ai_character deliverable_upload — đường media-direct có sẵn, kho của store) ⇒ PUT ⇒ link https.
    const uploaded = {};
    for (const f of files) {
      const t = await ai('deliverable_upload', { task: taskRef(BOARD, id), filename: basename(f), as: WHO });
      const buf = readFileSync(f);
      const res = await fetch(t.ticket.put_url, { method: 'PUT', body: buf, headers: { 'content-type': t.contentType, 'content-length': String(buf.length) }, signal: AbortSignal.timeout(300_000) });
      const j = await res.json().catch(() => ({}));
      const url = res.ok ? mediaUrlOf(j) : null;
      if (!url) die(`Tải "${basename(f)}" lên kho lỗi (HTTP ${res.status}${j?.error ? ` ${j.error}` : ''}) — chưa ghi gì lên thẻ; thử lại.`);
      uploaded[f] = url;
    }
    deliverables = outs.map((o) => toDeliverable(o, uploaded, gitInfo));
    reason = { ...reason, deliverables };
    const seeLine = outLine(deliverables);
    const body = [...body0, ...(seeLine ? [`6. Xem: ${seeLine}`] : [])].join('\n');
    // Lý do duyệt TRƯỚC khi chuyển cột: chỉ người đang cầm thẻ ghi được; task PHẢI dạng đầy đủ <board>#<thẻ> (số trần ⇒ cổng khoá lead báo not_yours).
    let rnote;
    try { await ai('approval_reason', reasonArgs(BOARD, id, WHO, reason)); rnote = `lý do ${reason.level} ✓`; }
    // #809/#817: không ghi được lý do ⇒ DỪNG trước bình luận + chuyển cột (máy chủ chặn vào Chờ duyệt khi thiếu lý do / bàn giao — đi tiếp chỉ
    // để lại bình luận "BÁO XONG" mồ côi rồi vẫn bị từ chối). In nguyên lỗi (vd web thiếu meta.shots) để sửa --out rồi chạy lại.
    catch (e) { die(`Chưa ghi được lý do duyệt — CHƯA bình luận, CHƯA chuyển cột: ${e?.message ?? e}`); }
    const r = await tb('comment_add', { task_id: id, body, audience: 'human' }); // #744: báo xong = cho người xem
    const cur = await columnOf(id).catch(() => null);
    let moved = dest;
    if (isApprovalColumn(cur)) { // đã ở Chờ duyệt (#664): không chuyển lại; --close vẫn thử đóng
      if (!flags.close) moved = 'Chờ duyệt (đã ở sẵn)';
      else {
        try { await tb('task_move', { task_id: id, column_name: 'Xong' }); }
        catch (e) { if (!/role_forbidden|forbidden/i.test(String(e?.message))) throw e; moved = 'Chờ duyệt — chờ người duyệt đóng (khoá của bạn không kéo thẻ ra khỏi Chờ duyệt)'; }
      }
    } else await tb('task_move', { task_id: id, column_name: dest });
    recordTouch(WHO, id);
    await ai('staff_status', { who: WHO, mode: 'set', state: 'idle', note: `xong #${id}` }).catch(() => {});
    console.log(`ok #${id} → ${moved} · ${rnote} · ${deliverables.length} sản phẩm${files.length ? ` (đã tải ${files.length} tệp lên kho)` : ""} · comment ${r.comment_id}`);
  },

  async accept() {
    const id = taskId(rest[0]); const text = rest.slice(1).join(' ').trim();
    if (!text) die('Thiếu nhận xét: dbio staff accept <thẻ> "<nhận xét>".');
    const reason = buildReason({ level: 'ok', state: text });
    if (flags.dry) { console.log(`[dry] approval_reason ${JSON.stringify(reasonArgs(BOARD, id, WHO, reason))} → Xong`); return; }
    await ai('approval_reason', reasonArgs(BOARD, id, WHO, reason));
    await tb('task_move', { task_id: id, column_name: 'Xong' });
    recordTouch(WHO, id);
    console.log(`ok ${taskRef(BOARD, id)} nghiệm thu → Xong · lý do ok: ${cut(text, 80)}`);
  },

  async hire() {
    if (flags.stats) {
      const who = rest.join(' ').trim();
      if (who) {
        const r = await ai('knowledge_stats', { character: who });
        console.log(hireStatsLine(r.character?.name, r.stats));
        console.log(`gần nhất: ${(r.recent ?? []).slice(0, 5).map((h) => `${h.task} ${h.outcome}`).join(' · ') || '—'}`);
        return;
      }
      const r = await ai('knowledge_stats', {});
      const list = r.characters ?? [];
      if (!list.length) { console.log('chưa có lần thuê tri thức nào'); return; }
      for (const s of list.slice(0, 10)) console.log(hireStatsLine(s.name ?? `nv#${s.character_id}`, s));
      return;
    }
    const id = taskId(rest[0]);
    let args;
    try { args = hireArgs(BOARD, id, WHO, flags.character, flags.model); } catch (e) { die(e.message); }
    if (flags.dry) { console.log(`[dry] knowledge_hire ${JSON.stringify(args)}`); return; }
    console.log(formatHire(await ai('knowledge_hire', args)));
  },

  async inbox() {
    const r = await ai('staff_inbox', { who: WHO, unread_only: !flags.all, limit: 30 });
    const all = r.items ?? [];
    // #679: ẩn tin do CHÍNH MÌNH gửi (vd tin @nhắc giao việc dội ngược vào hộp thư người giao); dùng lại isSelf của bộ lọc watch
    let meId = r.who?.id;
    if (meId == null && all.some((e) => e.from_character_id != null)) { try { meId = (await ai('staff_pulse', { who: WHO })).who?.id; } catch { /* không biết id ⇒ không ẩn */ } }
    const items = all.filter((e) => !isSelf(e, meId, WHO)); const mine = all.filter((e) => isSelf(e, meId, WHO));
    if (mine.length && flags['ack-self']) await ai('staff_inbox_ack', { who: WHO, ids: mine.map((e) => e.id) });
    if (mine.length) console.log(`(ẩn ${mine.length} tin do chính mình gửi${flags['ack-self'] ? ' — đã ack' : ' — thêm --ack-self để đánh dấu đã đọc'})`);
    if (!items.length) { console.log('hộp thư trống'); return; }
    for (const e of items) console.log(`${e.id} [${e.kind ?? ''}${isCopy(e) ? ` bản sao${e.copy_of != null ? ` của nv#${e.copy_of}` : ''}` : ''}] ${e.task ?? ''} ${e.from_character_id ? `nv#${e.from_character_id}` : e.from_user_id ? `u#${e.from_user_id}` : ''} ${e.at ?? ''}: ${cut(e.text, 300)}${e.attachments?.length ? ` (+${e.attachments.length} tệp)` : ''}`);
  },

  async ack() { const ids = rest.map(Number).filter((n) => Number.isInteger(n) && n > 0); if (!ids.length) die('Thiếu id.'); await ai('staff_inbox_ack', { who: WHO, ids }); console.log(`ok ack ${ids.join(',')}`); },

  async reply() { const id = taskId(rest[0]); if (!rest[1]) die('Thiếu nội dung.'); await ai('staff_reply', { who: WHO, task: ref(id), text: rest.slice(1).join(' ') }); console.log(`ok #${id} đã trả lời`); },

  async status() {
    const state = rest[0]; if (!state) die('Thiếu state: idle|working|waiting_owner|blocked');
    const runtime = { agent: 'claude_code', machine: hostname(), ...(flags.model ? { model: flags.model } : {}), ...(flags.session ? { session_ref: flags.session } : {}) };
    await ai('staff_status', { who: WHO, mode: 'set', state, ...(rest[1] ? { task: ref(taskId(rest[1])) } : {}), ...(flags.note ? { note: flags.note } : {}), runtime });
    console.log(`ok ${WHO} = ${state}${rest[1] ? ` #${taskId(rest[1])}` : ''}`);
  },
  /**
   * #744 KẸT CÓ LOẠI (một lệnh): `stuck <thẻ> --kind env|permission|tool|pm|owner|context "<vì sao, 1 dòng>" [--need "<cần gì để gỡ>"]`
   * ⇒ work_state {blocked, waiting, need} (GIỮ các trường cũ: worktree, sha…) — server tự ghi dòng KẸT cho người xem + báo Trưởng nhóm
   * (owner ⇒ @nhắc chủ) — rồi staff_status blocked / waiting_owner kèm ghi chú. `--clear` = hết kẹt (bỏ 3 trường, trạng thái working).
   */
  async stuck() {
    const id = taskId(rest[0]);
    const KINDS = ['env', 'permission', 'tool', 'pm', 'owner', 'context'];
    const VI = { env: 'môi trường', permission: 'quyền', tool: 'công cụ', pm: 'chờ PM', owner: 'chờ chủ', context: 'hết ngữ cảnh' };
    const prev = await tb('task_get', { task_id: id }).then((r) => r?.task?.work_state ?? {}).catch(() => ({}));
    // owner_hold KHÔNG gửi lại (server tự giữ cờ khi đầu vào không nhắc) — gửi lại sẽ làm lệch mốc đặt cờ.
    const keep = Object.fromEntries(Object.entries(prev && typeof prev === 'object' ? prev : {}).filter(([k]) => !['at', 'blocked', 'waiting', 'need', 'owner_hold'].includes(k)));
    /**
     * #818 CHỜ CHỦ MỘT PHẦN: một phần nhỏ cần tay chủ, phần còn lại vẫn làm ⇒ work_state.owner_hold — thẻ Ở LẠI Đang làm, hiện trong
     * "Cần anh xử lý" (tab Việc chính) + Telegram cho chủ; chủ bấm "Đã xử lý xong" ⇒ gỡ cờ + báo hộp thư. Trạng thái vẫn working.
     */
    if (flags.partial) {
      if (flags.clear) {
        await tb('checkpoint', { task_id: id, work_state: { ...keep, ...(prev?.blocked ? { blocked: prev.blocked, waiting: prev.waiting, ...(prev.need ? { need: prev.need } : {}) } : prev?.waiting ? { waiting: prev.waiting, ...(prev.need ? { need: prev.need } : {}) } : {}), owner_hold: null } });
        console.log(`ok #${id} gỡ cờ chờ chủ một phần`);
        return;
      }
      const kind = String(flags.kind ?? 'owner');
      if (!['owner', 'permission'].includes(kind)) die('--partial chỉ đi với --kind owner|permission (mặc định owner).');
      const why = String(flags.why ?? rest.slice(1).join(' ')).trim();
      if (!why) die('Thiếu 1 dòng việc chủ cần làm: dbio staff stuck <thẻ> --partial "<việc chủ cần làm>" --need "<cần gì>"');
      const need = flags.need ? String(flags.need).trim() : '';
      const hold = { kind, waiting: why, ...(need ? { need } : {}) };
      try { await tb('checkpoint', { task_id: id, work_state: { ...keep, ...(prev?.blocked ? { blocked: prev.blocked, waiting: prev.waiting, ...(prev.need ? { need: prev.need } : {}) } : prev?.waiting ? { waiting: prev.waiting, ...(prev.need ? { need: prev.need } : {}) } : {}), owner_hold: hold } }); }
      catch (e) { die(`checkpoint lỗi (server chưa có #818?): ${e?.message ?? e}`); }
      await ai('staff_status', { who: WHO, mode: 'set', state: 'working', task: ref(id), note: `chờ chủ một phần: ${why}${need ? ` · cần: ${need}` : ''}`.slice(0, 300) });
      console.log(`ok #${id} CHỜ CHỦ MỘT PHẦN (${VI[kind]}) · thẻ ở lại Đang làm · ${WHO} = working`);
      // #852: không còn việc nào khác đang làm ⇒ đây là chờ chủ CẢ thẻ — nhắc dùng stuck thường; máy chủ cũng tự chuyển sau N phút không hoạt động.
      const others = await otherDoingCards(id);
      if (others && !others.length) {
        console.log(`⚠ ${WHO} không còn thẻ nào khác ở Đang làm. Nếu đang CHỜ CHỦ cả thẻ, dùng: dbio staff stuck ${id} --kind ${kind} "<vì sao>" --need "<cần gì>" (thẻ sang "Cần anh xử lý").`);
        console.log(`  Thẻ chờ chủ một phần không có hoạt động (checkpoint / bình luận) quá N phút (mặc định 30, cài đặt sổ cái hold_idle_min) sẽ được máy chủ tự chuyển sang "Cần anh xử lý".`);
      }
      return;
    }
    if (flags.clear) {
      await tb('checkpoint', { task_id: id, work_state: keep });
      await ai('staff_status', { who: WHO, mode: 'set', state: 'working', task: ref(id), note: null });
      console.log(`ok #${id} hết kẹt · ${WHO} = working`);
      return;
    }
    const kind = String(flags.kind ?? '');
    if (!KINDS.includes(kind)) die(`--kind phải là ${KINDS.join('|')}`);
    const why = String(flags.why ?? rest.slice(1).join(' ')).trim();
    if (!why) die('Thiếu chi tiết 1 dòng: dbio staff stuck <thẻ> --kind pm "<vì sao>" --need "<cần gì>"');
    const need = flags.need ? String(flags.need).trim() : '';
    try { await tb('checkpoint', { task_id: id, work_state: { ...keep, blocked: kind, waiting: why, ...(need ? { need } : {}) } }); }
    catch (e) { die(`checkpoint lỗi (server chưa có #744 phần 5?): ${e?.message ?? e}`); }
    await ai('staff_status', { who: WHO, mode: 'set', state: kind === 'owner' ? 'waiting_owner' : 'blocked', task: ref(id), note: `${VI[kind]}: ${why}${need ? ` · cần: ${need}` : ''}`.slice(0, 300) });
    console.log(`ok #${id} KẸT (${VI[kind]}) · ${WHO} = ${kind === 'owner' ? 'waiting_owner' : 'blocked'}`);
  },

  /**
   * CANH TIN TỐI ƯU (#678, #759). Nhịp: 30s CHỈ khi có trao đổi chờ AI (chủ đang chat ≠ có việc cho nhân viên); 60s Trực thường; 300s khi server báo duyên Nghỉ
   * (duty.mode='off'). Mỗi lần gọi staff_pulse được đếm vào `polls` của dòng watch-log để `dbio usage` in ra.
   * Lọc/phân loại: lib/watch-filter.mjs (thuần, có test). Trạng thái: lib/watch-state.mjs.
   */
  async watch() {
    const MAX_MIN = Number(flags['max-min'] ?? 115) || 115;
    const MAX_MS = MAX_MIN * 60_000;
    const FAST = (Number(flags.fast) || 30) * 1000; const SLOW = (Number(flags.slow) || 60) * 1000; const REST = (Number(flags.rest) || 300) * 1000;
    const seen = loadSeen(WHO);
    const cardInfo = async (ids) => { const out = {}; await Promise.all([...new Set(ids.filter(Boolean))].map(async (id) => { try { const t = (await tb('task_get', { task_id: id, comments: 0, body_max: 0, description_max: 0 })).task; if (t) out[id] = { column: t.column?.name ?? null, labels: t.labels ?? [] }; } catch { /* không đọc được ⇒ cứ thức như cũ */ } })); return out; };
    let { queue, recent } = loadQueue(WHO);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sqlMs = (s) => (s ? Date.parse(String(s).includes('T') ? s : `${String(s).replace(' ', 'T')}Z`) : NaN);
    const finish = (code, text) => new Promise(() => { endBeat(WHO); process.stdout.write(`${text}\n`, () => process.exit(code)); }); // in xong mới thoát (ống Windows)
    const secretaries = loadSecretaries();
    const start = Date.now();
    let polls = 0; // số lần gọi staff_pulse (#759)
    const SWEEP_MIN = flags.sweep != null ? Number(flags.sweep) || 0 : null; // phút giữa hai lần quét sổ cái (null = 15 nếu là thư ký, 0 = tắt)
    const COALESCE = flags.coalesce != null ? Number(flags.coalesce) * 1000 : COALESCE_MS; // gộp tin đến gần nhau thành 1 lần thức
    let lastSweep = 0; let pendingSince = null; let pendingActs = [];
    let copies = 0; // số bản sao đã tự ack kể từ lần thức trước (chỉ để báo trong dòng tóm tắt)
    const copyNote = () => (copies ? ` · ${copies} bản sao đã ack (không thức)` : '');
    if (flags.fresh) { // --fresh: tin chưa đọc tạo trước lúc watch bắt đầu là TIN CŨ ⇒ ack hết, không báo, bỏ hàng đợi cũ
      const res = await ackStale(ai, WHO, start);
      for (const id of res.ids) seen.add(`inbox:${id}`);
      queue = []; recent = {}; saveSeen(WHO, seen); saveQueue(WHO, { queue, recent });
      console.error(`[watch] --fresh: đã ack ${res.ids.length} tin cũ${res.error ? ` (⚠️ dừng giữa chừng: ${res.error})` : ''}`);
    }
    recordBeat(WHO, { every: SLOW, started: start, pid: process.pid });
    while (Date.now() - start < MAX_MS) {
      const now = Date.now();
      let r;
      polls++;
      try { r = await ai('staff_pulse', { who: WHO }); } catch (e) { console.error(`[watch] lỗi tạm: ${e?.message ?? e} — thử lại sau 30s`); await sleep(30_000); continue; }
      const secretary = isSecretary(r.who, WHO, secretaries);
      const unreadIds = r.unread?.ids ?? [];
      const copyIds = new Set(secretary ? [] : (r.unread?.copy_ids ?? []));
      const newCopies = unreadIds.filter((i) => copyIds.has(i) && !seen.has(`inbox:${i}`));
      if (newCopies.length) { // máy chủ đã nói rõ đây là bản sao ⇒ ack luôn, khỏi tải nội dung
        for (const i of newCopies) seen.add(`inbox:${i}`);
        try { await ai('staff_inbox_ack', { who: WHO, ids: newCopies }); copies += newCopies.length; } catch { for (const i of newCopies) seen.delete(`inbox:${i}`); } // lỗi ⇒ thử lại vòng sau
      }
      const freshIds = new Set(unreadIds.filter((i) => !seen.has(`inbox:${i}`)));
      const freshTalk = (r.discuss_ai?.refs ?? []).filter((x) => !seen.has(`talk:${x}`));
      if (r.unread && unreadIds.length === (r.unread.count ?? -1)) queue = queue.filter((q) => !q.id || unreadIds.includes(q.id)); // tin đã đọc ở nơi khác ⇒ bỏ khỏi hàng đợi
      if (!secretary && r.unread?.direct_count === 0) queue = queue.filter((q) => !q.id); // toàn bản sao ⇒ không còn tin trực tiếp nào chờ
      if (freshIds.size) {
        let got;
        try { got = await fetchFreshItems(ai, WHO, [...freshIds]); } catch (e) { console.error(`[watch] lỗi tạm: ${e?.message ?? e} — thử lại sau 30s`); await sleep(30_000); continue; }
        const items = got.items;
        const cards = await cardInfo(items.map((e) => taskIdOf(e.task))); // #834: cột thẻ ⇒ bỏ tin thường trên thẻ chờ chủ
        const { keep, drop, recent: rc } = filterInbox(items, { meId: r.who?.id ?? got.who?.id, meName: WHO, secretary, touched: loadTouched(WHO), assigned: loadAssigned(WHO), recent, columns: Object.fromEntries(Object.entries(cards).map(([k, v]) => [k, v.column])), now });
        recent = rc;
        for (const e of items) seen.add(`inbox:${e.id}`);
        copies += drop.filter((d) => d.reason === 'copy').length;
        if (drop.length) await ai('staff_inbox_ack', { who: WHO, ids: drop.map((d) => d.item.id) }).catch(() => {}); // bỏ qua + tự ack, 0 token
        for (const k of keep) queue.push({ id: k.id, kind: k.kind, task: k.task, from_user_id: k.from_user_id ?? null, from_character_id: k.from_character_id ?? null, text: cut(k.text, 300), at: k.at, cls: k.cls, firstSeen: now });
      }
      const talkCards = await cardInfo(freshTalk.map(taskIdOf));
      for (const x of freshTalk) { seen.add(`talk:${x}`); if (isGopYTalk(talkCards[taskIdOf(x)])) continue; /* #834: góp ý thường không thức */ queue.push({ id: null, kind: 'talk', task: x, text: '', cls: 'urgent', firstSeen: now }); }
      saveSeen(WHO, seen); saveQueue(WHO, { queue, recent });
      // #745: thư ký quét sổ cái bằng SCRIPT (0 token) mỗi SWEEP_MIN phút — chỉ khi ra việc thật mới thức (thay cho thức định kỳ 55')
      const sweepEvery = SWEEP_MIN ?? (secretary ? 15 : 0);
      if (secretary && sweepEvery > 0 && now - lastSweep >= sweepEvery * 60_000) {
        lastSweep = now;
        try { const sw = await runSweep({ ai, tb, now }); pendingActs.push(...sw.actions); } catch (e) { console.error(`[watch] quét sổ cái lỗi tạm: ${e?.message ?? e}`); }
      }
      const w = shouldWake(queue, now);
      const willWake = (w.wake && directGate(queue, r.unread, secretary)) || pendingActs.length > 0;
      if (!willWake) pendingSince = null;
      const gate = willWake ? coalesceGate(pendingSince, now, COALESCE) : { emit: false, pendingSince: null };
      pendingSince = gate.pendingSince;
      if (willWake && !gate.emit) { recordBeat(WHO, { every: COALESCE }); await sleep(COALESCE); continue; } // chờ tin đến thêm trong ~20s rồi in MỘT lần
      if (willWake) {
        const { show, rest: left } = pickBatch(queue, MAX_SHOW);
        const cols = new Map(); // thẻ → tên cột (1 lệnh/thẻ, 0 token)
        await Promise.all([...new Set(show.map((i) => taskIdOf(i.task)).filter(Boolean))].map(async (id) => {
          try { cols.set(id, (await tb('task_get', { task_id: id, comments: 0, body_max: 0, description_max: 0 })).task?.column?.name); } catch { /* không có task_get ⇒ bỏ cột */ }
        }));
        const nUrg = show.filter((i) => i.cls === 'urgent').length;
        const ids = show.map((i) => i.id).filter(Boolean);
        let ackNote = 'đã ack tự động — KHÔNG cần inbox/ack/card';
        if (ids.length) { try { await ai('staff_inbox_ack', { who: WHO, ids }); } catch (e) { ackNote = `⚠️ ack lỗi (${e?.message ?? e}) — chạy: dbio staff ack ${ids.join(' ')}`; } }
        queue = left; saveQueue(WHO, { queue, recent });
        logWatchExit({ staff: WHO, woke: true, items: show.length + pendingActs.length, urgent: nUrg, left: left.length, copies, polls });
        const acts = pendingActs; pendingActs = [];
        const head = `⚡ ${nUrg} khẩn · ${show.length - nUrg} thường${acts.length ? ` · ${acts.length} việc quét sổ cái` : ''}${left.length ? ` · còn ${left.length} tin chờ lượt sau` : ''}${copyNote()} · ${ackNote}`;
        await finish(0, [head, ...show.map((i) => formatItem(i, cols.get(taskIdOf(i.task))))].concat(acts.map(formatAction)).join('\n'));
      }
      const resting = !secretary && r.duty?.mode === 'off'; // #660: server báo Nghỉ; thiếu trường = đang Trực · #872: thư ký KHÔNG nghỉ (cầu khẩn phải thức ngay)
      const nap = (r.discuss_ai?.count ?? 0) > 0 ? FAST : resting ? REST : SLOW; // #759: bỏ owner_active khỏi FAST
      recordBeat(WHO, { every: nap });
      await sleep(nap);
    }
    const w = shouldWake(queue);
    logWatchExit({ staff: WHO, woke: false, items: 0, urgent: 0, queued: queue.length, copies, polls });
    await finish(3, `hết ${MAX_MIN}p · không có việc cần quyết${queue.length ? ` (${queue.length} tin thường đang gom, cũ nhất ${Math.round(w.oldestMs / 60_000)}p)` : ''}${copyNote()}`);
  },

  /** #745 phần 3: thẻ kế tiếp đã giao cho tôi (lib/secretary.mjs pickNext). */
  async next() {
    const board = await tb('get');
    const r = pickNext({ tasks: board.data?.tasks ?? [], columns: board.data?.columns ?? [], meName: WHO });
    console.log(formatNext(r));
    if (flags.all && r.queue.length) console.log(r.queue.map((t) => `  #${t.id} [${t.priority}] ${String(t.title).slice(0, 80)}`).join(String.fromCharCode(10)));
    if (!r.next) { process.exitCode = 3; return; }
    if (flags.take) {
      await tb('task_move', { task_id: r.next.id, column_name: 'Đang làm' }); recordTouch(WHO, r.next.id);
      await ai('staff_status', { who: WHO, mode: 'set', state: 'working', task: ref(r.next.id), runtime: { agent: 'claude_code', machine: hostname() } });
      console.log(`ok nhận #${r.next.id} → Đang làm · ${WHO} = working`);
    }
  },

  /** #745 phần 2: quét sổ cái cho thư ký (lib/secretary-io.mjs). */
  async sweep() {
    const { actions, scanned, checked } = await runSweep({ ai, tb, mark: !flags.dry });
    if (!actions.length) { console.log(`✓ không có việc cho thư ký (quét ${scanned} thẻ, kiểm bình luận ${checked})`); return; }
    console.log(`${actions.length} việc (quét ${scanned} thẻ, kiểm bình luận ${checked})${flags.dry ? ' [dry: chưa ghi nhớ]' : ''}`);
    console.log(actions.slice(0, flags.full ? 50 : 8).map(formatAction).join(String.fromCharCode(10)));
  },

  async call() {
    if (!rest[0]) die("Dùng: call <tool> '<json>'");
    let a = {}; try { a = rest[1] ? JSON.parse(rest[1]) : {}; } catch { die('JSON args không hợp lệ.'); }
    console.log(JSON.stringify(await c.call(rest[0], a)));
  },
};

if (!cmds[cmd]) die(`Lệnh lạ "${cmd}". Có: ${Object.keys(cmds).join(' · ')}`);
await run(cmds[cmd]);
