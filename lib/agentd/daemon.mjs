/**
 * lib/agentd/daemon.mjs — LÕI daemon dbio-agentd: mỗi nhân viên trên máy này = MỘT kết nối kênh `staff:` (khoá riêng của nó) ⇒ tin tới ⇒ lọc ⇒
 * luật (rules.mjs) ⇒ adapter đánh thức phiên. Thêm: tự dò nhân viên theo runtime.machine, quét sổ cái định kỳ (luật nhắc), tệp trạng thái cho `status`.
 * IO tách qua `deps` (test thay được): loadCfg · stream · makeClient · adapters · now · log. Không bao giờ in khoá.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { keyFile, pmName } from '../common.mjs';
import { pickNext } from '../secretary.mjs';
import { readBeat } from '../watch-state.mjs';
import { runSweep } from '../secretary-io.mjs';
import { loadSecretaries } from '../watch-state.mjs';
import { fetchFreshItems } from '../watch-fetch.mjs';
import { streamDir } from '../stream/cursor.mjs';
import { runStream } from '../stream/session.mjs';
import { discoverFromStaffList, loadConfig } from './config.mjs';
import { getAdapter, loadAdapterModules } from './adapters/index.mjs';
import { makeOwnCommentCheck } from '../own-comment.mjs';
import { makeStaleCheck } from '../stale-card.mjs';
import { ACTIVE_MS, buildCompactRelay, buildPrompt, buildRelayMessage, buildReloadRelay, decideWake, listenerAlive, splitSweep } from './rules.mjs';

export const statusFile = () => process.env.DBIO_AGENTD_STATUS || join(homedir(), '.dbio', 'agentd.status.json');
export const readStatus = () => { try { return JSON.parse(readFileSync(statusFile(), 'utf8')); } catch { return null; } };

export function createDaemon(deps = {}) {
  const now = deps.now ?? (() => Date.now());
  /** #965: MỖI lượt thức/hoãn/thất bại = 1 dòng trong <log_dir>/<tên>.wake.log (mã thoát · thời gian · lý do hoãn). Test (deps.log) không ghi ra home. */
  const staffLog = deps.staffLog ?? (deps.log ? () => {} : (name, line) => { try { const d = process.env.DBIO_AGENTD_LOG_DIR || join(homedir(), '.dbio', 'agentd-logs'); mkdirSync(d, { recursive: true }); appendFileSync(join(d, `${String(name).replace(/[^p{L}p{N}_-]/gu, '_')}.wake.log`), `${new Date().toISOString()} ${line}
`); } catch { /* log phụ, bỏ */ } });
  const log = deps.log ?? ((m) => console.error(`[agentd ${new Date().toISOString().slice(11, 19)}] ${m}`));
  const stream = deps.stream ?? runStream;
  const makeClient = deps.makeClient;               // (name) ⇒ {ai, tb, init} — bắt buộc khi dùng sweep / dò / ack SSE
  const adapterOf = deps.getAdapter ?? getAdapter;
  const machine = deps.machine ?? hostname();
  const hasKey = deps.hasKey ?? ((n) => existsSync(keyFile(n)));
  const loadCfg = deps.loadCfg ?? (() => loadConfig());

  let cfg = null; let cfgErrors = []; let discovered = {};
  const streams = new Map();      // tên → {s, entry}
  const st = new Map();           // tên → {adapter, lastWakeAt, lastWake, lastError, wakes, failures, retryAt, inflight}
  const timers = []; let started = Date.now(); let stopped = false;
  const stOf = (n) => { if (!st.has(n)) st.set(n, { adapter: null, wakes: 0, failures: 0, retryAt: 0, inflight: null, lastWakeAt: null, lastWake: null, lastError: null }); return st.get(n); };

  const effective = () => ({ ...discovered, ...cfg.staff });

  /** #872: thức lỗi (xác thực CLI hết hạn, tiến trình chết…) ⇒ KHÔNG im lặng: ghi KẸT lên thẻ của tin đầu + cầu thư ký, tối đa 1 lần / giờ / nhân viên. */
  async function reportStuck(name, events, s) {
    const auth = /oauth|expired|unauthori[sz]ed|authenticat|not logged|log ?in|401/i.test(String(s.lastError ?? ''));
    if (!auth && s.failures < 3) return;
    if (s.stuckAt && now() - s.stuckAt < 3_600_000) return;
    const ev = (events ?? []).find((b) => /^\d+#\d+$/.test(String(b.task ?? ''))); if (!ev || !makeClient) return;
    const to = cfg.defaults.relay_to || loadSecretaries()[0]; const [board, task] = String(ev.task).split('#').map(Number);
    s.stuckAt = now();
    const why = String(s.lastError ?? '').replace(/\s+/g, ' ').replace(/[@＠`<>\[\]()]/g, ' ').replace(/(bearer\s+\S+|sk[-_][\w-]{8,})/gi, '***').slice(0, 200);
    await makeClient(name).call('task_board', { action: 'comment_add', profile_id: board, task_id: task, as: name, body: `🛑 KẸT (dbio-agentd): không đánh thức được phiên của ${name} (${s.failures} lần liên tiếp)${auth ? ' — nghi ĐĂNG NHẬP claude CLI trên máy này hết hạn, cần đăng nhập lại' : ''}. Lỗi: ${why}.${to ? ` Nhờ @${to} nhắn thẳng (send_message) vào phiên ghim của ${name} và báo chủ.` : ''}` });
    log(`${name}: đã báo KẸT lên thẻ ${ev.task}`);
  }

  async function wakeNow(name, entry, prompt, events) {
    const ad = adapterOf(entry.adapter);
    const s = stOf(name); s.adapter = entry.adapter;
    if (!ad) { s.lastError = `adapter lạ: ${entry.adapter}`; log(`${name}: ${s.lastError}`); return { ok: false, detail: s.lastError }; }
    let r;
    try { r = await ad.wake({ staff: name, entry, prompt, events, timeoutS: Number(cfg.defaults.wake_timeout_s), env: process.env }); } catch (e) { r = { ok: false, detail: e?.message ?? String(e) }; }
    if (r.ok && r.running) { // tiến trình con chết sớm (ENOENT, mã ≠ 0) ⇒ KHÔNG coi là đã thức, để tin ở lại thử lại
      const grace = Number(cfg.defaults.spawn_grace_s ?? 5) * 1000;
      const early = await Promise.race([r.running, new Promise((res) => { const t = setTimeout(() => res(null), grace); t.unref?.(); })]);
      if (early) r = { ok: early.code === 0 && !early.error, running: Promise.resolve(early), detail: early.code === 0 && !early.error ? r.detail : `tiến trình thoát sớm (mã ${early.code}${early.error ? `, ${early.error}` : ''}) ${String(early.out ?? '').trim().slice(-160)}` };
    }
    s.lastWakeAt = new Date(now()).toISOString(); s.lastWake = r.detail ?? null;
    if (r.ok) { s.wakes++; s.failures = 0; s.lastError = null; if (r.running) { const t0 = now(); s.inflight = r.running.then((x) => { s.inflight = null; staffLog(name, `THỨC xong mã=${x?.code ?? '?'} ${Math.round((now() - t0) / 1000)}s`); log(`${name}: lượt thức xong (mã ${x?.code ?? '?'}${x?.session_id ? `, phiên mới ${x.session_id}` : ''})`); }); } }
    else { s.failures++; s.lastError = r.detail ?? 'lỗi'; staffLog(name, `THỨC thất bại — ${String(s.lastError).slice(0, 200)}`); reportStuck(name, events, s).catch((e) => { s.stuckAt = null; log(`${name}: báo KẸT lỗi — ${e?.message ?? e}`); }); s.retryAt = now() + (r.blocked ? 300 : Number(cfg.defaults.retry_s)) * 1000; log(`${name}: thức thất bại — ${s.lastError} (thử lại sau ${cfg.defaults.retry_s}s)`); }
    return r;
  }

  /** Sổ cầu theo thẻ trên đĩa {<thẻ>: {n, at}} — sống qua lần daemon khởi động lại (launcher tự chạy lại sau 10s), chống spam bình luận. */
  const relayLedger = (name) => {
    const f = join(streamDir(), `${String(name).replace(/[^\p{L}\p{N}_-]/gu, '_')}.agentd.relay.json`);
    return {
      load() { try { const j = JSON.parse(readFileSync(f, 'utf8')); const out = {}; for (const [k, v] of Object.entries(j)) if (now() - Number(v.at) < 24 * 3_600_000) out[k] = v; return out; } catch { return {}; } },
      save(o) { try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(`${f}.tmp`, JSON.stringify(o)); renameSync(`${f}.tmp`, f); } catch { /* bỏ */ } },
    };
  };

  /** #965 sổ dọn phiên {n, at, escalatedAt} theo nhân viên (sống qua khởi động lại; hết hạn 24h). */
  const compactLedger = (name) => {
    const f = join(streamDir(), `${String(name).replace(/[^\p{L}\p{N}_-]/gu, '_')}.agentd.compact.json`);
    return {
      load() { try { const j = JSON.parse(readFileSync(f, 'utf8')); return now() - Number(j.at) < 24 * 3_600_000 ? j : {}; } catch { return {}; } },
      save(o) { try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(`${f}.tmp`, JSON.stringify(o)); renameSync(`${f}.tmp`, f); } catch { /* bỏ */ } },
      clear() { try { writeFileSync(f, '{}'); } catch { /* bỏ */ } },
    };
  };

  /**
   * #965 ƯU TIÊN 1 (chủ 9/10): phiên QUÁ NGƯỠNG ⇒ TỰ DỌN, không đứng chờ người. Lượt thức ngầm không có công cụ clear_session ⇒ cầu thư ký
   * send_message LỆNH CỐ ĐỊNH (checkpoint · dừng nền · tắt RC · clear self) vào đúng phiên ghim (1 lượt cache nguội, chấp nhận).
   * Cách nhau compact_retry_min; tối đa compact_max_tries lần rồi báo @trưởng nhóm 1 lần/giờ. `card` = "<sổ>#<thẻ>" nơi đặt lời cầu. ⇒ false (không bao giờ ack).
   */
  async function compactSession(name, entry, card, g, text = '') {
    const s = stOf(name); const to = cfg.defaults.relay_to || loadSecretaries()[0];
    if (!makeClient || !to || !/^\d+#\d+$/.test(String(card ?? ''))) { s.lastError = `phiên ${Math.round((g?.tokens ?? 0) / 1000)}k quá ngưỡng nhưng không tự dọn được (${!to ? 'chưa khai relay_to' : 'không có thẻ để đặt lời cầu'})`; s.retryAt = now() + Number(cfg.defaults.retry_s) * 1000; return false; }
    const cl = compactLedger(name); const rec = cl.load(); const tries = Number(cfg.defaults.compact_max_tries ?? 3);
    if (rec.at && now() - rec.at < Number(cfg.defaults.compact_retry_min ?? 15) * 60_000 && (rec.n ?? 0) > 0) return false; // đã cầu gần đây: chờ thư ký/phiên
    const [board, task] = String(card).split('#').map(Number); const c = makeClient(name);
    try {
      if ((rec.n ?? 0) >= tries) { // hết lượt thử ⇒ báo trưởng nhóm 1 lần/giờ (lệnh clear tự động không thành)
        if (rec.escalatedAt && now() - rec.escalatedAt < 3_600_000) return false;
        await c.call('task_board', { action: 'comment_add', profile_id: board, task_id: task, as: name, body: `🛑 KẸT (dbio-agentd): phiên ${name} ~${Math.round((g?.tokens ?? 0) / 1000)}k token quá ngưỡng, đã cầu dọn ${rec.n} lần mà phiên chưa clear. @${pmName()} nhờ nhắn thẳng (send_message) vào phiên ghim của ${name} lệnh clear; nếu bị từ chối vì thiếu ủy quyền thì báo chủ.` });
        cl.save({ ...rec, escalatedAt: now() }); s.lastError = `dọn phiên thất bại ${rec.n} lần — đã báo ${pmName()}`; staffLog(name, `DỌN PHIÊN thất bại ${rec.n} lần — báo ${pmName()}`); log(`${name}: ${s.lastError}`);
        return false;
      }
      const n = (rec.n ?? 0) + 1;
      await c.call('task_board', { action: 'comment_add', profile_id: board, task_id: task, as: name, body: buildCompactRelay({ name, session: entry.session, to, tokens: g?.tokens, max: g?.max, batch: [{ task: card, kind: 'compact', text }], attempt: n, tries }) });
      cl.save({ n, at: now() }); s.relayAt = now(); s.lastWakeAt = new Date(now()).toISOString(); s.lastWake = `cầu DỌN → ${to} (phiên ~${Math.round((g?.tokens ?? 0) / 1000)}k, lần ${n}/${tries})`; s.lastError = null; s.compacts = (s.compacts ?? 0) + 1;
      staffLog(name, `CẦU DỌN lần ${n}/${tries} → ${to} (~${Math.round((g?.tokens ?? 0) / 1000)}k > ${Math.round((g?.max ?? 0) / 1000)}k) trên ${card}`); log(`${name}: phiên ~${Math.round((g?.tokens ?? 0) / 1000)}k quá ngưỡng ⇒ cầu ${to} dọn (clear) lần ${n}/${tries} trên thẻ ${card}`);
    } catch (e) { s.lastError = `gửi cầu dọn lỗi: ${e?.message ?? e}`; s.retryAt = now() + Number(cfg.defaults.retry_s) * 1000; log(`${name}: ${s.lastError}`); }
    return false;
  }

  /** Phiên TRỐNG mà nhân viên còn cầm thẻ, không có tin để kích: cầu nạp vai (≤ 1 lần / thẻ / reload_every_min). */
  async function reloadBlank(name, entry, card) {
    const s = stOf(name); const to = cfg.defaults.relay_to || loadSecretaries()[0]; if (!makeClient || !to) return false;
    const every = Number(cfg.rules.hygiene?.reload_every_min ?? 60) * 60_000; s.reloadAt ??= {};
    // v0.3.2 dự phòng: đã cầu nạp vai ≥ reload_ack_min (5') mà phiên VẪN trống ⇒ thư ký chưa nhắn được ⇒ báo thẳng PM (1 lần / lời cầu).
    s.reloadEsc ??= {}; const ackMs = Number(cfg.rules.hygiene?.reload_ack_min ?? 5) * 60_000; const sent = s.reloadAt[card];
    if (sent && s.reloadEsc[card] !== sent && now() - sent >= ackMs) {
      const [eb, et] = String(card).split('#').map(Number); const mins = Math.round((now() - sent) / 60_000);
      try {
        await makeClient(name).call('task_board', { action: 'comment_add', profile_id: eb, task_id: et, as: name, body: `🛑 DỰ PHÒNG (dbio-agentd) @${pmName()}: đã cầu ${to} nạp vai cho ${name} (phiên ghim ${entry.session}) cách đây ${mins} phút mà phiên vẫn TRỐNG, còn cầm thẻ ${card}. Nhờ nhắn thẳng (send_message) vào phiên: "Bạn là ${name}. Phiên vừa được clear. Nạp vai (/staff), rồi dbio-staff staff --as \"${name}\" takeover ${et} và làm tiếp theo hồ sơ làm việc trên thẻ".` });
        s.reloadEsc[card] = sent; staffLog(name, `DỰ PHÒNG: nạp vai chưa ack sau ${mins}' ⇒ báo ${pmName()} trên ${card}`); log(`${name}: cầu nạp vai chưa ack ⇒ báo ${pmName()} (${card})`);
      } catch (e) { s.lastError = `gửi dự phòng nạp vai lỗi: ${e?.message ?? e}`; log(`${name}: ${s.lastError}`); }
    }
    if (now() - (s.reloadAt[card] ?? 0) < every || now() - Number(relayLedger(name).load()[card]?.at ?? 0) < every) return false; // vừa cầu (kể cả đường theo tin)
    const [board, task] = String(card).split('#').map(Number);
    try {
      await makeClient(name).call('task_board', { action: 'comment_add', profile_id: board, task_id: task, as: name, body: buildReloadRelay({ name, session: entry.session, to, card }) });
      s.reloadAt[card] = now(); s.lastWakeAt = new Date(now()).toISOString(); s.lastWake = `cầu NẠP VAI → ${to} (thẻ ${card})`; staffLog(name, `CẦU NẠP VAI → ${to} trên ${card}`); log(`${name}: phiên trống, còn cầm ${card} ⇒ cầu ${to} nạp vai`);
      return true;
    } catch (e) { s.lastError = `gửi cầu nạp vai lỗi: ${e?.message ?? e}`; log(`${name}: ${s.lastError}`); return false; }
  }

  /**
   * #965 dọn chủ động (không cần tin tới): phiên RẢNH (≥ idle_min, không listen) mà (a) quá ngưỡng và đang cầm thẻ ⇒ cầu dọn; (b) vừa trống mà còn cầm thẻ ⇒ cầu nạp vai.
   * Không cầm thẻ ⇒ để yên (CLAUDE.md: phiên trống, có việc thì agentd đánh thức) — tin tới sẽ đi đường theo tin. Tắt từng phiên: "auto_compact": false.
   */
  async function hygiene() {
    const hy = cfg.rules.hygiene; if (!hy?.enabled || !makeClient || cfg.defaults.auto_compact === false) return;
    for (const [name, entry] of Object.entries(effective())) {
      if (entry.auto_compact === false || entry.secretary || entry.blank_mode === 'headless' || !hasKey(name)) continue;
      const ad = adapterOf(entry.adapter); if (!ad?.overLimit || !ad.isBlank) continue;
      const s = stOf(name); if (s.inflight || listenerAlive(readBeat(name), now())) continue;
      const act = ad.activeAgoMs?.(entry); if (act != null && act < Number(hy.idle_min ?? 15) * 60_000) continue;
      let blank = false; let g = null; try { blank = !!ad.isBlank(entry); g = blank ? null : ad.overLimit(entry); } catch { continue; }
      if (blank) { const cl = compactLedger(name); if (cl.load().n) { cl.clear(); staffLog(name, 'DỌN PHIÊN xong (phiên trống)'); } }
      else if (!g?.blocked) continue;
      try {
        const c = makeClient(name); const board = await c.init(); const b = await c.tb('get');
        const r = pickNext({ tasks: b.data?.tasks ?? [], columns: b.data?.columns ?? [], meName: name }); const t = r.doing[0] ?? r.next; if (!t) continue; const card = `${board}#${t.id}`;
        if (blank) await reloadBlank(name, entry, card); else await compactSession(name, entry, card, g, 'dọn phiên nặng khi rảnh');
      } catch (e) { log(`${name}: dọn chủ động lỗi — ${e?.message ?? e}`); }
    }
  }

  /** #965: thẻ nhân viên đang cầm (Đang làm / Đã giao có nhãn @tên) ⇒ Set "<sổ>#<thẻ>"; null = không tra được. Đệm 60s (deliver gọi ~4 lần/giây). */
  async function heldCards(name) {
    const s = stOf(name); if (s.held && now() - s.held.at < 60_000) return s.held.set;
    if (!makeClient) return null;
    try {
      const c = makeClient(name); const board = await c.init(); const b = await c.tb('get');
      const r = pickNext({ tasks: b.data?.tasks ?? [], columns: b.data?.columns ?? [], meName: name });
      s.held = { at: now(), set: new Set([...r.doing, ...(r.next ? [r.next] : []), ...r.queue].map((t) => `${board}#${t.id}`)) };
      return s.held.set;
    } catch { return null; }
  }

  /** Phiên trống: ghi lời CẦU (kèm @thư ký) lên thẻ của tin đầu tiên. true = đã cầu (giữ tin chưa ack tới hạn kiểm lại). */
  async function relayBlank(name, entry, batch, busy = false) {
    const s = stOf(name); s.adapter = entry.adapter;
    const ev = batch.find((b) => /^\d+#\d+$/.test(String(b.task ?? '')));
    if (!ev || !makeClient) { s.lastError = 'phiên trống nhưng tin không gắn thẻ — không có chỗ đặt lời cầu'; s.retryAt = now() + Number(cfg.defaults.retry_s) * 1000; log(`${name}: ${s.lastError}`); return false; }
    const to = cfg.defaults.relay_to || loadSecretaries()[0]; // tên thư ký: defaults.relay_to trong agentd.json, hoặc secretaries[0] trong ~/.dbio/watch.json
    if (!to) { s.lastError = 'phiên trống nhưng chưa khai relay_to (tên thư ký) trong agentd.json'; s.retryAt = now() + 300_000; log(`${name}: ${s.lastError}`); return false; }
    const [board, task] = String(ev.task).split('#').map(Number);
    const rl = relayLedger(name); const rec = rl.load(); const k = String(ev.task); const maxRelays = Number(cfg.defaults.max_relays ?? 3);
    if ((rec[k]?.n ?? 0) >= maxRelays) { s.lastError = `đã cầu ${maxRelays} lần trên ${k} mà phiên chưa thức — cần người xử lý`; s.relayAt = now(); log(`${name}: ${s.lastError}`); return false; }
    if (rec[k]?.at && now() - rec[k].at < Math.max(Number(cfg.defaults.redeliver_after_min ?? 10), Number(cfg.defaults.relay_card_min ?? 60)) * 60_000) { s.relayAt = rec[k].at; return false; } // #965: mỗi (nhân viên, thẻ) tối đa 1 lần cầu / relay_card_min (60') — hết PM thức vô ích // đã cầu gần đây (kể cả trước khi daemon khởi động lại)
    try {
      await makeClient(name).call('task_board', { action: 'comment_add', profile_id: board, task_id: task, as: name, body: buildRelayMessage({ name, session: entry.session, to, batch: [ev, ...batch.filter((b) => b !== ev)], busy }) });
      rec[k] = { n: (rec[k]?.n ?? 0) + 1, at: now(), ids: batch.map((b) => b.id).filter((x) => x != null) }; rl.save(rec);
      s.relayAt = now(); s.lastWakeAt = new Date(now()).toISOString(); s.lastWake = `cầu → ${to} (${busy ? 'phiên bận' : 'phiên trống'})`; s.lastError = null; s.relays = (s.relays ?? 0) + 1;
      log(busy ? `${name}: phiên đang BẬN, ${batch.length} tin chưa đọc ⇒ đã gửi cầu nhắc cho ${to} trên thẻ ${ev.task} (không --resume song song)` : `${name}: phiên TRỐNG ⇒ đã gửi cầu cho ${to} trên thẻ ${ev.task}`);
    } catch (e) { s.lastError = `gửi cầu lỗi: ${e?.message ?? e}`; s.retryAt = now() + Number(cfg.defaults.retry_s) * 1000; log(`${name}: ${s.lastError}`); }
    return false; // KHÔNG ack: phiên thức sẽ tự nhận tin qua listen + ack; chưa thì tới hạn kiểm lại
  }

  /** deliver() của một nhân viên: true = đã xử lý (ack), false = giữ lại thử sau. */
  function deliverFor(name) {
    return async (batch) => {
      const entry = effective()[name]; if (!entry) return false;
      const s = stOf(name);
      if (now() < s.retryAt) return false;
      const ad = adapterOf(entry.adapter); let blank = false; let activeAgoMs = null;
      try { // đọc đĩa tối đa 1 lần / 5 giây / nhân viên (deliver được gọi ~4 lần/giây khi tin đang chờ)
        if (!s.probeAt || now() - s.probeAt > 5000) { s.probeAt = now(); s.blank = !!ad?.isBlank?.(entry); s.activeAgo = ad?.activeAgoMs?.(entry) ?? null; }
        blank = s.blank; activeAgoMs = s.activeAgo;
      } catch { /* bỏ */ }
      const d = decideWake({ batch, beat: readBeat(name), now: now(), confirmMs: Number(cfg.defaults.listener_confirm_s) * 1000, redeliverMs: Number(cfg.defaults.redeliver_after_min ?? 10) * 60_000, inflight: !!s.inflight, blank, activeAgoMs });
      let forced = false;
      if (d === 'busy' || d === 'defer') { // #872: hoãn PHẢI có log lý do + hạn tối đa (Mac: queued=2, wakes=0, không một dòng log)
        const inflight = !!s.inflight; if (s.holdAt && now() - s.holdAt > 120_000) s.holdSince = null; s.holdAt = now(); s.holdSince ??= now(); // holdAt cũ > 2' = lần hoãn trước đã kết thúc ⇒ tính hạn lại
        const why = inflight ? 'lượt thức trước còn chạy' : d === 'defer' ? 'listen của phiên đang nghe, chờ nó tự thức' : 'phiên đang hoạt động hoặc listen vừa thoát (chờ giao lại)';
        const heldMin = Math.round((now() - s.holdSince) / 60000);
        if (s.holdWhy !== why || now() - (s.holdLogAt ?? 0) > 300_000) { s.holdWhy = why; s.holdLogAt = now(); staffLog(name, `HOÃN ${batch.length} tin — ${why} (đã ${heldMin}p)`); log(`${name}: HOÃN thức ${batch.length} tin — ${why} (đã hoãn ${heldMin}p)`); }
        if (inflight || now() - s.holdSince < Number(cfg.defaults.max_hold_min ?? 20) * 60_000) return false;
        forced = true; s.holdSince = null; s.holdWhy = null; log(`${name}: hoãn quá ${heldMin}p ⇒ ÉP đi tiếp (kiểm tin chưa đọc rồi thức/cầu)`);
      } else { s.holdSince = null; s.holdWhy = null; s.holdAt = null; }
      const relayMs = Number(cfg.defaults.redeliver_after_min ?? 10) * 60_000;
      // ĐÃ CẦU thư ký cho lô này ⇒ tin đang trên đường tới phiên. Gác này KHÔNG được phụ thuộc `blank`: phiên thức xong là hết trống,
      // trước đây rơi xuống wakeNow nên daemon tự gõ lại vào phiên = thức TRÙNG.
      const relayedIds = new Set(Object.values(relayLedger(name).load()).flatMap((v) => v.ids ?? []));
      const batchIds = batch.map((x) => x.id).filter((x) => x != null);
      if (!forced && s.relayAt && now() - s.relayAt < relayMs && batchIds.some((id) => relayedIds.has(id))) { // chỉ áp cho lô CÓ tin đã cầu — tin thẻ khác đi đường thường (không bị chặn 10')
        const activeAt = activeAgoMs != null ? now() - activeAgoMs : null; // mốc phiên ghi hội thoại lần cuối
        if (activeAt == null || activeAt <= s.relayAt) return false; // phiên chưa nhúc nhích sau lời cầu ⇒ chờ, chưa ack
        if (!batchIds.every((id) => relayedIds.has(id))) return false; // lô lẫn tin CHƯA từng cầu ⇒ không ack thay phiên; hết hạn sẽ đi đường thường
        s.relayAt = 0; s.lastWake = 'cầu → phiên đã tự thức (coi là đã giao)'; s.lastWakeAt = new Date(now()).toISOString(); s.lastError = null;
        const rl2 = relayLedger(name); const rec2 = rl2.load(); for (const b of batch) delete rec2[String(b.task)]; rl2.save(rec2);
        log(`${name}: phiên ghi hội thoại SAU lời cầu ⇒ coi tin ${batchIds.join(',')} là ĐÃ GIAO (thư ký nhắn được) — không thức trùng`);
        return true;
      }
      const sessionActive = activeAgoMs != null && activeAgoMs < ACTIVE_MS;
      const viaRelay = (blank || (forced && sessionActive)) && entry.blank_mode !== 'headless'; // ÉP mà phiên vẫn đang hoạt động ⇒ KHÔNG --resume song song: cầu thư ký nhắn vào phiên // PM chốt (b): phiên ghim phải HIỆN trong app ⇒ gửi CẦU cho thư ký (send_message), KHÔNG chạy claude -p ẩn
      let items = batch;
      if (d === 'verify' || forced) { // `listen` lẽ ra đã thức phiên: nếu máy chủ báo tin đã đọc thì thôi, còn chưa đọc ⇒ đánh thức
        try { const got = await fetchFreshItems(makeClient(name).ai, name, batch.map((b) => b.id)); items = batch.filter((b) => got.items.some((g) => Number(g.id) === Number(b.id))); } catch (e) { log(`${name}: không kiểm được tin chưa đọc (${e?.message ?? e}) — coi như chưa đọc`); }
        if (!items.length) return true;
      }
      if (blank) { const cl = compactLedger(name); if (cl.load().n) { cl.clear(); staffLog(name, 'DỌN PHIÊN xong (phiên trống) ⇒ cầu nạp vai'); log(`${name}: phiên đã được dọn (trống) ⇒ chuyển sang cầu nạp vai`); } }
      if (!blank && !viaRelay && !sessionActive && cfg.defaults.auto_compact !== false && entry.auto_compact !== false && entry.blank_mode !== 'headless') { // #965: quá ngưỡng ⇒ TỰ DỌN (cầu thư ký clear) thay vì chặn chờ người
        if (!s.limitAt || now() - s.limitAt > 30_000) { s.limitAt = now(); s.limit = ad?.overLimit?.(entry) ?? null; } // đọc đuôi tệp hội thoại ≤ 1 lần / 30s (deliver được gọi ~4 lần/giây)
        const g = s.limit;
        if (g?.blocked) return compactSession(name, entry, items.find((b) => /^\d+#\d+$/.test(String(b.task ?? '')))?.task, g, items[0]?.text);
        const cl = compactLedger(name); if (cl.load().n && g && !g.blocked) cl.clear(); // đã nhẹ lại
      }
      if (viaRelay && blank && cfg.defaults.skip_idle_blank !== false) { // #965: phiên trống mà KHÔNG cầm thẻ nào liên quan tới tin ⇒ không cầu (PM thức vô ích), tin cũ đã xử lý ⇒ ack
        const held = await heldCards(name);
        if (held && !items.some((b) => b.kind === 'assign' || b.kind === 'owner_assign' || held.has(String(b.task ?? '')))) {
          staffLog(name, `BỎ ${items.length} tin — phiên trống, không cầm thẻ liên quan (không cầu)`); log(`${name}: phiên trống, không cầm thẻ nào liên quan tới ${items.length} tin ⇒ ack, không cầu`);
          return true;
        }
      }
      if (viaRelay) return relayBlank(name, entry, items, !blank);
      const r = await wakeNow(name, entry, buildPrompt(name, items, entry.prompt_template ?? cfg.defaults.prompt_template), items);
      return !!r.ok;
    };
  }

  function startStaff(name, entry) {
    if (!hasKey(name)) { log(`${name}: chưa có khoá trên máy này — bỏ qua`); return; }
    let s;
    try {
      s = stream({
        name, consumer: 'agentd', freshKeepMs: Number(cfg.defaults.fresh_keep_hours ?? 6) * 3_600_000, fresh: cfg.defaults.first_run !== 'backlog' /* lần ĐẦU (chưa có con trỏ): bỏ qua hàng đợi cũ, không thức cả loạt phiên vì tin tuần trước */, secretary: !!entry.secretary, sse: !!entry.sse, coalesceMs: Number(cfg.defaults.coalesce_ms),
        log: (m) => log(`${name}: ${m}`), deliver: deliverFor(name), isOwn: makeClient ? makeOwnCommentCheck((t, a) => makeClient(name).call(t, a), { as: name }) : null, isStale: makeClient ? makeStaleCheck((t, a) => makeClient(name).call(t, a), { as: name }) : null,
        ackFallback: makeClient ? (ids) => makeClient(name).ai('staff_inbox_ack', { who: name, ids }) : null,
      });
    } catch (e) { log(`${name}: không mở được kênh — ${e.message}`); return; }
    s.done.catch((e) => { log(`${name}: kênh dừng — ${e.message}`); stOf(name).lastError = e.message; streams.delete(name); });
    streams.set(name, { s, entry });
    log(`${name}: nghe kênh (adapter ${entry.adapter})`);
  }

  async function reconcile() {
    if (stopped) return;
    const eff = effective();
    for (const [n, h] of [...streams]) if (!eff[n]) { h.s.stop(); streams.delete(n); log(`${n}: gỡ khỏi cấu hình — ngừng nghe`); }
    for (const [n, e] of Object.entries(eff)) {
      const cur = streams.get(n);
      if (cur && JSON.stringify(cur.entry) !== JSON.stringify(e)) { cur.s.stop(); streams.delete(n); }
      if (!streams.has(n)) startStaff(n, e);
    }
  }

  async function discover() {
    const d = cfg.discover; if (!d.enabled || !makeClient) return;
    try { const r = await makeClient(d.as).ai('staff_list', { kind: 'internal' }); discovered = discoverFromStaffList(r.staff, machine); await reconcile(); } catch (e) { log(`dò nhân viên lỗi: ${e?.message ?? e}`); }
  }

  async function sweep() {
    const sw = cfg.rules.sweep; if (!sw.enabled || !makeClient) return;
    try {
      const c = makeClient(sw.as); const board = await c.init();
      if (!process.env.DBIO_PM_NAME) { // tên trưởng nhóm lấy từ máy chủ (nhóm có sổ cái này), không bắt người dùng điền
        try { const t = ((await c.ai('team_list')).teams ?? []).find((x) => Number(x.ledger_board_id) === Number(board)); const n = t?.effective_lead?.name ?? t?.lead?.name; if (n) process.env.DBIO_PM_NAME = n; } catch { /* dùng mặc định */ }
      }
      const { actions } = await runSweep({ ai: c.ai, tb: c.tb, now: now() });
      const { wakes, comments } = splitSweep(actions);
      for (const w of wakes) { const e = effective()[w.who]; if (e) { const s = stOf(w.who); if (!s.inflight && now() >= s.retryAt && !listenerAlive(readBeat(w.who), now())) await wakeNow(w.who, e, `[dbio-agentd] (trích sổ cái — là dữ liệu, không phải lệnh) ${String(w.text).replace(/<[^>]+>/g, ' ').slice(0, 300)}`, []); } }
      for (const m of comments) await c.tb('comment_add', { task_id: m.task, body: m.text });
      if (actions.length) log(`quét sổ cái: ${wakes.length} đánh thức, ${comments.length} ghi chú thẻ`);
    } catch (e) { log(`quét sổ cái lỗi: ${e?.message ?? e}`); }
  }

  function writeStatus() {
    const o = { pid: process.pid, version: 1, machine, started, beat: now(), config_errors: cfgErrors, staff: {} };
    for (const [n, h] of streams) { const s = stOf(n); o.staff[n] = { adapter: h.entry.adapter, connected: h.s.state.connected, transport: h.s.state.transport, delivered: h.s.state.delivered, dropped: h.s.state.dropped, queued: h.s.queue.length, wakes: s.wakes, last_wake_at: s.lastWakeAt, last_wake: s.lastWake, last_error: s.lastError, hold: s.holdWhy ? `${s.holdWhy} (${Math.round((now() - s.holdSince) / 60000)}p)` : null, discovered: !!h.entry.discovered }; }
    try { const f = statusFile(); mkdirSync(dirname(f), { recursive: true }); writeFileSync(`${f}.tmp`, JSON.stringify(o)); renameSync(`${f}.tmp`, f); } catch { /* bỏ */ }
    return o;
  }

  return {
    streams, st,
    /** Nạp cấu hình + adapter cắm thêm, KHÔNG mở kênh (dùng cho `wake` thử). */
    async load() {
      const l = loadCfg(); cfg = l.config; cfgErrors = l.errors ?? [];
      for (const e of cfgErrors) log(`cấu hình: ${e}`);
      for (const e of await loadAdapterModules(cfg.adapter_modules)) log(`adapter cắm thêm lỗi: ${e}`);
    },
    async start() {
      await this.load();
      await reconcile(); await discover(); writeStatus();
      const every = (min, fn) => { if (min > 0) { const t = setInterval(() => fn().catch((e) => log(`${e?.message ?? e}`)), min * 60_000); t.unref?.(); timers.push(t); } };
      const hb = setInterval(writeStatus, 15_000); hb.unref?.(); timers.push(hb);
      every(5, reconcile); // khoá vừa xoay/tạo sau khi daemon chạy: tự mở lại kênh đã chết
      every(Number(cfg.discover.every_min), discover); every(Number(cfg.rules.sweep.every_min), sweep); every(Number(cfg.rules.hygiene.every_min), hygiene);
      if (cfg.rules.sweep.enabled) setTimeout(() => sweep().catch(() => {}), 10_000).unref?.();
      const rl = setInterval(async () => { // nạp lại cấu hình khi tệp đổi (không cần khởi động lại)
        try { const n = loadCfg(); if (JSON.stringify(n.config) !== JSON.stringify(cfg)) { cfg = n.config; cfgErrors = n.errors ?? []; log('cấu hình đổi — áp dụng'); await reconcile(); writeStatus(); } } catch { /* bỏ */ }
      }, 30_000); rl.unref?.(); timers.push(rl);
      return { staff: [...streams.keys()] };
    },
    stop() { stopped = true; for (const t of timers) clearInterval(t); for (const h of streams.values()) h.s.stop(); streams.clear(); },
    reconcile, discover, sweep, hygiene, writeStatus, wakeNow: (n, text) => { const e = effective()[n]; return e ? wakeNow(n, e, text, []) : Promise.resolve({ ok: false, detail: `${n}: không có trong cấu hình` }); },
    get config() { return cfg; },
  };
}
