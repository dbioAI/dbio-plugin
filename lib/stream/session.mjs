/**
 * lib/stream/session.mjs — vòng sống của MỘT khoá nhân viên trên kênh `staff:` (dùng chung cho `dbio-staff listen` và daemon `dbio-agentd`).
 *   nối (WS, rơi về SSE) → hello → backlog → caught_up → tin mới; nối lại có lùi theo `since`, khử trùng theo id, con trỏ ở đĩa.
 *   mỗi tin: lọc (self / copy / dup / owner-wait… = watch-filter, một nguồn luật) → hàng đợi đĩa → CỔNG thức (khẩn ⇒ gom coalesceMs rồi thức; thường ⇒ gom đủ lô/tuổi)
 *   → deliver(batch) trả true = đã xử lý ⇒ ack + bỏ khỏi hàng đợi; false = chưa (vd phiên đang bận) ⇒ giữ, thử lại ở nhịp sau.
 * IO tách ra: connect / loaders có thể thay khi test. Không bao giờ in khoá.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyFile } from '../common.mjs';
import { COALESCE_MS, coalesceGate, filterInbox, pickBatch, shouldWake } from '../watch-filter.mjs';
import { loadAssigned, loadTouched } from '../watch-state.mjs';
import { loadCursor, saveCursor, streamDir } from './cursor.mjs';
import { backoffMs, closePolicy, dedupe, eventToItem, httpPolicy, isSystemFrame } from './protocol.mjs';
import { connect as realConnect } from './transport.mjs';

const readJson = (f, d) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d; } catch { return d; } };
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

export function loadKey(name) {
  const f = keyFile(name);
  if (!existsSync(f)) { const e = new Error(`Chưa có khoá cho "${name}" (${f})`); e.fatal = true; throw e; }
  const c = JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));
  if (!c.key || !c.mcp_url) { const e = new Error(`Tệp khoá hỏng: ${f}`); e.fatal = true; throw e; }
  return c;
}

/**
 * opts: name · consumer ('listen'|'agentd') · deliver(batch[items+cls]) ⇒ Promise<boolean> · secretary · coalesceMs · sse · fresh ·
 *       log(msg) · ackFallback(ids) (khi SSE) · connect (test) · now (test) · tickMs
 * ⇒ {stop(), done: Promise (kết thúc khi stop() hoặc lỗi nặng ném ra), state}
 */
export function runStream(opts) {
  const { name, consumer, deliver, secretary = false, coalesceMs = COALESCE_MS, sse = false, fresh = false, log = () => {}, ackFallback = null, connect = realConnect, tickMs = 250, backoff = backoffMs } = opts;
  const now = () => (opts.now ? opts.now() : Date.now());
  const cfg = opts.cfg ?? loadKey(name);
  const host = new URL(cfg.mcp_url).hostname;
  const ac = new AbortController();
  const qfile = join(streamDir(), `${String(name).replace(/[^\p{L}\p{N}_-]/gu, '_')}.${consumer}.queue.json`);
  const saveQ = () => { try { mkdirSync(streamDir(), { recursive: true }); writeFileSync(`${qfile}.tmp`, JSON.stringify({ queue, recent })); renameSync(`${qfile}.tmp`, qfile); return true; } catch { return false; } };
  const q0 = fresh && loadCursor(name, consumer, host) == null ? {} : readJson(qfile, {}); // --fresh chỉ bỏ tin cũ ở lần ĐẦU (chưa có con trỏ); chạy lại thì giữ hàng đợi
  let queue = Array.isArray(q0.queue) ? q0.queue : []; // [{...item, cls, firstSeen}]
  let recent = q0.recent && typeof q0.recent === 'object' ? q0.recent : {};
  const dd = dedupe(loadCursor(name, consumer, host));
  const state = { self: null, connected: false, transport: null, attempts: 0, lastFrameAt: 0, delivered: 0, dropped: 0 };
  let conn = null; let chain = Promise.resolve(); let pendingSince = null; let stopped = false; let fatal = null;
  const acks = new Set();

  const flushAck = (ids) => { if (!ids.length) return; if (!(conn && conn.ack(ids))) ackFallback?.(ids).catch((e) => log(`ack lỗi: ${e?.message ?? e}`)); };

  /** Xử lý lần lượt từng khung (hàng chờ nối đuôi ⇒ tin được lọc đúng thứ tự, caught_up chỉ chạy SAU backlog). */
  const onFrame = (f) => { state.lastFrameAt = now(); chain = chain.then(() => handle(f)).catch((e) => log(`khung lỗi: ${e?.message ?? e}`)); };

  async function handle(f) {
    if (f.type === 'hello') { state.self = f.self ?? null; if (dd.cursor == null && fresh && typeof f.cursor === 'number') { dd.cursor = f.cursor; saveCursor(name, consumer, host, f.cursor); } return; }
    if (f.type === 'caught_up' || f.type === 'pong') { if (typeof f.cursor === 'number' && f.cursor > (dd.cursor ?? -1) && f.more !== true) { dd.cursor = f.cursor; saveCursor(name, consumer, host, f.cursor); } return; }
    if (f.type === 'error') { log(`máy chủ báo lỗi: ${f.code ?? '?'} ${f.message ?? ''}`); return; }
    if (isSystemFrame(f)) return;
    if (dd.isDup(f.id)) return;
    const item = eventToItem(f);
    const ctx = { meId: state.self?.id ?? null, meName: state.self?.name ?? name, secretary, assigned: loadAssigned(name), touched: loadTouched(name), recent, now: now() };
    const r = filterInbox([item], ctx);
    recent = r.recent;
    if (r.drop.length) { state.dropped++; acks.add(f.id); log(`bỏ #${f.id} (${r.drop[0].reason})`); }
    for (const k of r.keep) queue.push({ ...k, firstSeen: now() });
    const saved = saveQ(); dd.mark(f.id); if (saved) saveCursor(name, consumer, host, dd.cursor); // hàng đợi chưa xuống đĩa ⇒ KHÔNG đẩy con trỏ (nối lại sẽ nhận lại tin)
    if (r.drop.length) { flushAck([...acks]); acks.clear(); }
  }

  let ticking = false;
  async function tick() {
    if (ticking) return; // deliver chậm (webhook, adapter) ⇒ không chạy chồng 2 lượt lên cùng một lô
    ticking = true;
    try { await tickOnce(); } finally { ticking = false; }
  }
  async function tickOnce() {
    if (stopped || !queue.length) { pendingSince = null; return; }
    const w = shouldWake(queue, now());
    if (!w.wake) { pendingSince = null; return; }
    const g = coalesceGate(pendingSince, now(), coalesceMs); pendingSince = g.pendingSince;
    if (!g.emit) return;
    const { show } = pickBatch(queue);
    let ok = false;
    try { ok = await deliver(show); } catch (e) { log(`deliver lỗi: ${e?.message ?? e}`); }
    if (ok) {
      const ids = show.map((x) => x.id).filter((x) => x != null);
      queue = queue.filter((x) => !ids.includes(x.id)); saveQ(); state.delivered += show.length; pendingSince = null;
      flushAck(ids);
    }
  }

  const done = (async () => {
    const ticker = setInterval(() => { tick().catch((e) => log(`tick lỗi: ${e?.message ?? e}`)); }, tickMs); ticker.unref?.();
    try {
      let attempt = 0; let wsFails = 0; let useSse = false;
      while (!stopped) {
        state.attempts++;
        const since = dd.cursor;
        let openedAt = 0;
        conn = connect({ mcpUrl: cfg.mcp_url, key: cfg.key, since, sse: sse || useSse, onFrame, onOpen: () => { state.connected = true; openedAt = now(); } });
        state.transport = conn.transport;
        const res = await conn.done;
        state.connected = false; conn = null;
        await chain;
        if (stopped) break;
        if (res.status && !httpPolicy(res.status).retry) { const e = new Error(`kênh từ chối (HTTP ${res.status}${res.reason ? ` ${res.reason}` : ''}) — kiểm khoá nhân viên`); e.fatal = true; throw e; }
        if (state.transport === 'ws') { if (res.opened) wsFails = 0; else if (++wsFails >= 2 && !useSse) { useSse = true; log('WebSocket không nối được — chuyển sang SSE (cũng cho biết lý do nếu khoá bị từ chối)'); } }
        const p = closePolicy(res.code);
        if (!p.retry) { log(`kênh đóng ${res.code} — không nối lại`); break; }
        if (openedAt && now() - openedAt > 30_000) attempt = 0;
        const wait = p.backoff ? backoff(attempt++) : 0;
        log(`mất kênh (${res.code || res.error || res.reason || '?'}) — nối lại sau ${Math.round(wait / 1000)}s từ since=${dd.cursor ?? '-'}`);
        if (wait) await sleep(wait, ac.signal);
      }
    } catch (e) { fatal = e; } finally { clearInterval(ticker); }
    if (fatal) throw fatal;
  })();

  return { done, state, get queue() { return queue; }, tick, stop() { stopped = true; ac.abort(); try { conn?.close(); } catch { /* bỏ */ } } };
}
