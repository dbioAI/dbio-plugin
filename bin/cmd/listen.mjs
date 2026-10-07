#!/usr/bin/env node
/**
 * dbio-staff listen --as "<tên>" — NGHE kênh sự kiện `staff:` (WebSocket đẩy, SSE dự phòng). Thay cho `staff watch` (vòng hỏi) khi máy chủ có kênh.
 *
 *   listen [--max-min 115] [--fresh] [--coalesce <ms>] [--sse] [--secretary] [--quiet]
 *
 *   Chạy NỀN trong phiên (run_in_background): có tin cần làm ⇒ in (≤2 dòng/tin) rồi THOÁT 0 ⇒ phiên thức, xử lý xong chạy lại lệnh này (nối lại theo con trỏ ở đĩa, không sót).
 *   Độ trễ từ lúc giao thẻ tới lúc phiên thức: ≤ ~2s (máy chủ) + gom --coalesce (mặc định 1500ms).
 *   Lọc giống `watch` (tin tự mình gửi, bản sao, trùng, góp ý, chờ chủ… bỏ + tự ack, 0 token). Tin KHẨN thức ngay; tin thường gom (≥5 tin hoặc > 20 phút).
 *   --fresh: bỏ qua tin có trước lúc bắt đầu (phiên mới không bị đánh thức bởi tin cũ).  --sse: ép dùng SSE (WS bị chặn / Node < 22 tự rơi về SSE).
 *   Hết giờ (mặc định 115' < trần 2h của app) ⇒ in ĐÚNG 1 dòng, thoát 3. Khoá sai/thiếu ⇒ thoát 2.
 *   Khoá: ~/.dbio/staff-keys/<tên>.json (không bao giờ in). Con trỏ: ~/.dbio/stream/<tên>.listen.cursor.json.
 * Mã thoát: 0 có tin · 1 lỗi · 2 khoá/danh tính · 3 hết giờ.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { client, die, helpOf, parseArgs, whoAmI } from '../../lib/common.mjs';
import { makeStaleCheck } from '../../lib/stale-card.mjs';
import { formatItem } from '../../lib/watch-filter.mjs';
import { streamDir } from '../../lib/stream/cursor.mjs';
import { runStream } from '../../lib/stream/session.mjs';
import { endBeat, logWatchExit, recordBeat } from '../../lib/watch-state.mjs';

const { flags } = parseArgs(process.argv.slice(2), ['--max-min', '--coalesce']);
if (flags.help || flags.h) die(helpOf(import.meta.url), 0);
if (process.env.DBIO_AGENTD_TURN) die('[listen] chặn: đang trong lượt thức NGẦM của dbio-agentd (headless) — không bật listen nền (listener mồ côi sống sau lượt sẽ nuốt tin). Xử lý xong thì kết thúc; daemon lo việc nghe.', 4);
const WHO = whoAmI(flags);
const maxMs = Math.max(0.01, Number(flags['max-min'] ?? 115)) * 60_000;
const log = flags.quiet ? () => {} : (m) => console.error(`[listen] ${m}`);

/**
 * ACK KHI PHIÊN XỬ LÝ (#872): listen KHÔNG ack tin nó vừa giao (phiên có thể vừa bị clear / chết trước khi đọc). Id tin đã giao ghi vào tệp "chờ ack";
 * lần chạy lại `listen` kế tiếp (= phiên đã xử lý xong và quay lại nghe) mới ack chúng. Chưa ack ⇒ máy chủ vẫn báo chưa đọc ⇒ daemon dbio-agentd giao lại sau redeliver_after_min.
 */
const pendingFile = join(streamDir(), `${String(WHO).replace(/[^\p{L}\p{N}_-]/gu, '_')}.listen.pending.json`);
const readPending = () => { try { return existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, 'utf8')).ids ?? [] : []; } catch { return []; } };
const writePending = (ids) => { try { mkdirSync(streamDir(), { recursive: true }); writeFileSync(`${pendingFile}.${process.pid}.tmp`, JSON.stringify({ ids, at: new Date().toISOString() })); renameSync(`${pendingFile}.${process.pid}.tmp`, pendingFile); } catch { /* bỏ */ } };

let woke = false; let items = 0; let urgent = 0;
let resolveWake; const wake = new Promise((r) => { resolveWake = r; });
const c = client(WHO);
let s;
const prev = readPending();
if (prev.length) { try { await c.ai('staff_inbox_ack', { who: WHO, ids: prev }); try { unlinkSync(pendingFile); } catch { /* đã xoá */ } log(`đã ack ${prev.length} tin của lượt trước (phiên đã xử lý)`); } catch (e) { log(`ack tin lượt trước lỗi (giữ lại thử lần sau): ${e?.message ?? e}`); } }
try {
  s = runStream({
    name: WHO, consumer: 'listen', secretary: !!flags.secretary, sse: !!flags.sse, fresh: !!flags.fresh, log,
    coalesceMs: flags.coalesce != null ? Number(flags.coalesce) : 1500,
    ackDelivered: false, isStale: makeStaleCheck((t, a) => c.call(t, a), { as: WHO }),
    ackFallback: (ids) => c.ai('staff_inbox_ack', { who: WHO, ids }),
    deliver: async (batch) => {
      for (const it of batch) console.log(formatItem(it, null));
      writePending([...new Set([...readPending(), ...batch.map((x) => x.id).filter((x) => x != null)])]);
      woke = true; items = batch.length; urgent = batch.filter((x) => x.cls === 'urgent').length; resolveWake(); return true;
    },
  });
} catch (e) { die(`lỗi: ${e.message}`, e.fatal ? 2 : 1); }

const beat = () => recordBeat(WHO, { mode: 'listen', every: 60_000, machine: hostname() });
beat(); const hb = setInterval(beat, 30_000); hb.unref();
const timeout = new Promise((r) => { const t = setTimeout(() => r('timeout'), maxMs); t.unref?.(); });
const failed = s.done.then(() => 'closed', (e) => { throw e; });
let code = 0;
try {
  const r = await Promise.race([wake.then(() => 'wake'), timeout, failed]);
  if (r === 'timeout') { console.log(`[listen] hết giờ ${Math.round(maxMs / 60_000 * 10) / 10}p, không có tin — chạy lại lệnh nền`); code = 3; }
  else if (r === 'closed') { console.error('[listen] kênh đóng — chạy lại lệnh nền'); code = 1; }
} catch (e) { console.error(`lỗi: ${e.message}`); code = e.fatal ? 2 : 1; }
await new Promise((r) => setTimeout(r, 150)); // cho khung ack kịp đi
s.stop(); clearInterval(hb); endBeat(WHO);
logWatchExit({ staff: WHO, woke, items, urgent, polls: 0, mode: 'listen' });
process.exit(code);
