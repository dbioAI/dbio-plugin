#!/usr/bin/env node
/**
 * dbio-agentd — daemon NHẬN VIỆC cho nhân viên AI trên máy này (thay phiên AI thư ký): giữ kết nối kênh đẩy `staff:` bằng khoá riêng từng nhân viên,
 * có việc ⇒ gọi ADAPTER đánh thức đúng phiên (Claude CLI · Claude Desktop · Codex · Hermes · lệnh tuỳ chỉnh). 0 token LLM cho phần canh.
 *
 *   run                      chạy daemon (dịch vụ gọi lệnh này)
 *   install [--dry]          cài thành dịch vụ người dùng: launchd (macOS) · Task Scheduler (Windows) · systemd --user (Linux); tự chạy lại khi thoát
 *   uninstall [--dry]        gỡ dịch vụ (giữ cấu hình + log)
 *   status [--json]          dịch vụ có đang chạy? từng nhân viên: kết nối · số lần thức · lỗi cuối
 *   init [--force]           ghi tệp cấu hình mẫu (~/.dbio/agentd.json)
 *   wake <tên> [lời nhắc]    thử đánh thức một nhân viên qua adapter đã cấu hình (kiểm cấu hình mà không chờ việc thật)
 *   adapters                 danh sách adapter
 *   runs [--month YYYY-MM] [--staff <tên>] [--limit N] [--json]   sổ Run do agentd ĐO (model thật, tài khoản, token vào/cache/ra từ CLI; thiếu ⇒ trống, không 0) + tỉ lệ run có usage thật
 *   lease acquire|renew|release|status <tài nguyên> …   lease cả máy cho tài nguyên chia sẻ (hiện: browser = Chrome thật, 1 chủ/lúc); acquire --holder <tên> [--ttl 300] [--pid N]; renew/release --holder <tên> --gen N
 *
 * Cấu hình: MỘT tệp ~/.dbio/agentd.json (DBIO_AGENTD_CONFIG đổi đường dẫn) — xem README mục "Daemon dbio-agentd". Khoá: ~/.dbio/staff-keys/<tên>.json (không in, không ghi log).
 * Mã thoát: 0 ok · 1 lỗi · 2 thiếu cấu hình/khoá.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, die, helpOf, parseArgs } from '../lib/common.mjs';
import { SAMPLE, configFile } from '../lib/agentd/config.mjs';
import { adapterNames } from '../lib/agentd/adapters/index.mjs';
import { createDaemon, readStatus } from '../lib/agentd/daemon.mjs';
import { installPlan } from '../lib/agentd/service.mjs';
import { ageMin } from '../lib/agentd/rules.mjs';
import { installPm2, statusPm2, uninstallPm2 } from '../lib/agentd/pm2-cli.mjs';
import { createRunStore, summarize } from '../lib/agentd/runs.mjs';
import { createLeases, RESOURCES } from '../lib/agentd/lease.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2), ['--month', '--staff', '--limit', '--holder', '--gen', '--ttl', '--pid', '--run']);
const [cmd, ...rest] = pos;
if (!cmd || flags.help || flags.h) die(helpOf(import.meta.url), 0);
const SCRIPT = resolve(fileURLToPath(import.meta.url));

const cmds = {
  async run() {
    const clients = new Map();
    const makeClient = (n) => { if (!clients.has(n)) clients.set(n, client(n, { throwAuth: true })); return clients.get(n); };
    const d = createDaemon({ makeClient });
    const r = await d.start();
    if (!r.staff.length) console.error('[agentd] chưa có nhân viên nào để nghe — thêm vào cấu hình (' + configFile() + '), daemon vẫn chạy và tự nạp lại khi tệp đổi.');
    const bye = () => { d.stop(); d.writeStatus(); process.exit(0); };
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
    // để lại dấu vết khi chết (#1036: 14/10 chết lặng, log không có dòng nào)
    const stamp = (m) => { try { process.stderr.write(`[agentd ${new Date().toISOString().slice(11, 19)}Z] ${m}\n`); } catch { /* bỏ */ } };
    process.on('uncaughtException', (e) => { stamp(`uncaughtException (bỏ qua, daemon vẫn chạy): ${e?.stack ?? e}`); });
    process.on('unhandledRejection', (e) => stamp(`unhandledRejection: ${e?.stack ?? e}`));
    process.on('SIGHUP', () => { stamp('SIGHUP'); bye(); }); process.on('SIGBREAK', () => { stamp('SIGBREAK'); bye(); });
    process.on('exit', (c) => stamp(`thoát mã ${c}`));
    await new Promise(() => {}); // sống mãi
  },

  async install() {
    if (flags.pm2) { const r = installPm2({ script: SCRIPT, flags, configFile }); if (!r.ok) die(`lỗi: ${r.error}`); return; }
    const plan = installPlan({ platform: process.platform, node: process.execPath, script: SCRIPT, home: homedir(), env: { PATH: process.env.PATH, DBIO_AGENTD_CONFIG: process.env.DBIO_AGENTD_CONFIG } });
    if (flags.dry) { for (const f of plan.files) console.log(`# ghi ${f.path}\n${f.content}`); for (const c of plan.install) console.log(`$ ${c.join(' ')}`); return; }
    if (!existsSync(configFile())) console.error(`[agentd] lưu ý: chưa có ${configFile()} — chạy \`dbio-agentd init\` rồi điền nhân viên.`);
    mkdirSync(join(homedir(), '.dbio', 'agentd-logs'), { recursive: true });
    for (const f of plan.files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.content); }
    for (const [c, ...a] of plan.install) { const r = spawnSync(c, a, { encoding: 'utf8' }); if (r.status !== 0 && !/unload/.test(a[0] ?? '')) die(`lỗi: ${[c, ...a].join(' ')} → ${(r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 200)}`); }
    console.log(`ok đã cài dịch vụ (${plan.platform}). Kiểm: dbio-agentd status${plan.notes.length ? `\n${plan.notes.join('\n')}` : ''}`);
  },

  async uninstall() {
    if (flags.pm2) return uninstallPm2({ script: SCRIPT, flags });
    const plan = installPlan({ platform: process.platform, node: process.execPath, script: SCRIPT, home: homedir() });
    if (flags.dry) { for (const c of plan.uninstall) console.log(`$ ${c.join(' ')}`); for (const f of plan.remove) console.log(`# xoá ${f}`); return; }
    for (const [c, ...a] of plan.uninstall) spawnSync(c, a, { encoding: 'utf8' });
    for (const f of plan.remove) { try { unlinkSync(f); } catch { /* chưa có */ } }
    console.log('ok đã gỡ dịch vụ (cấu hình + log còn nguyên).');
  },

  async status() {
    const plan = installPlan({ platform: process.platform, node: process.execPath, script: SCRIPT, home: homedir() });
    let registered; if (flags.pm2) { const ps = statusPm2({ script: SCRIPT }); registered = ps.registered; console.log(ps.line); } else { registered = spawnSync(plan.query[0], plan.query.slice(1), { encoding: 'utf8' }).status === 0; }
    const st = readStatus();
    const alive = !!st && Date.now() - st.beat < 45_000;
    if (flags.json) { console.log(JSON.stringify({ service_registered: registered, running: alive, ...st })); return; }
    console.log(`dịch vụ: ${registered ? 'đã cài' : 'CHƯA cài'} · daemon: ${alive ? `ĐANG CHẠY (pid ${st.pid}, ${Math.round((Date.now() - st.started) / 60_000)} phút)` : 'KHÔNG chạy'}${st?.machine ? ` · máy ${st.machine}` : ''}`);
    for (const e of st?.config_errors ?? []) console.log(`⚠️ cấu hình: ${e}`);
    if (alive && st?.slots) console.log(`  slot: ${st.slots.used}/${st.slots.max} đang dùng${(st.runs ?? []).length ? ` · run mở: ${st.runs.map((r) => `${r.staff}${r.card ? ` ${r.card}` : ''}${r.slot_returned ? ' (đã trả slot)' : ''}`).join(', ')}` : ''}`);
    for (const [n, s] of Object.entries(st?.staff ?? {})) console.log(`  ${n} · ${s.adapter}${s.discovered ? ' (tự dò)' : ''} · ${s.connected ? `nối ${s.transport}` : 'MẤT KẾT NỐI'} · thức ${s.wakes} lần${s.last_wake_at ? ` (cuối ${ageMin(s.last_wake_at)}p trước)` : ''}${s.queued ? ` · chờ ${s.queued}` : ''}${s.hold ? ` · ⏸ hoãn: ${s.hold}` : ''}${s.last_error ? ` · ⚠️ ${s.last_error}` : ''}`);
    if (!Object.keys(st?.staff ?? {}).length && alive) console.log('  (chưa có nhân viên nào — xem cấu hình)');
  },

  async init() {
    const f = configFile();
    if (existsSync(f) && !flags.force) die(`${f} đã có (dùng --force để ghi đè).`);
    mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(SAMPLE, null, 2)}\n`);
    console.log(`ok đã ghi ${f} — điền tên nhân viên + adapter + session rồi \`dbio-agentd wake "<tên>"\` để thử.`);
  },

  async wake() {
    const name = rest[0]; if (!name) die('Dùng: wake <tên nhân viên> [lời nhắc]');
    const d = createDaemon({ makeClient: (n) => client(n, { throwAuth: true }) });
    await d.load();
    const r = await d.wakeNow(name, rest.slice(1).join(' ') || `[dbio-agentd] Thử đánh thức ${name} — chỉ cần trả lời "ok".`);
    if (r.running) { const x = await r.running; console.log(`${r.ok ? 'ok' : 'LỖI'} ${r.detail} → mã thoát ${x.code}${x.out ? `\n${x.out.trim().slice(-600)}` : ''}`); process.exit(x.code === 0 ? 0 : 1); }
    console.log(`${r.ok ? 'ok' : 'LỖI'} ${r.detail ?? ''}`); process.exit(r.ok ? 0 : 1);
  },

  async adapters() { console.log(adapterNames().join(' · ')); },

  async runs() {
    const store = createRunStore({});
    const list = store.list({ month: flags.month === true ? undefined : flags.month, staff: flags.staff === true ? null : (flags.staff ?? null), limit: Number(flags.limit) > 0 ? Number(flags.limit) : 200 });
    const sum = summarize(list);
    if (flags.json) { console.log(JSON.stringify({ summary: sum, runs: list })); return; }
    const k = (n) => (n == null ? '—' : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
    for (const r of list.slice(0, 30).reverse()) {
      const t = r.tokens;
      console.log(`${new Date(r.started_at).toISOString().slice(5, 16).replace('T', ' ')} ${(r.staff ?? '').padEnd(8)} ${(r.card ?? '—').padEnd(10)} ${(r.outcome ?? 'đang chạy').padEnd(11)} ${String(r.models?.[0]?.model ?? r.models?.[0] ?? r.model_requested ?? "—").padEnd(22)} ${r.account ?? '—'} · vào ${k(t?.input)} cache-đọc ${k(t?.cache_read)} cache-ghi ${k(t?.cache_write)} ra ${k(t?.output)}`);
    }
    console.log(`tổng ${sum.runs} run (${sum.running} đang chạy) · có usage thật ${sum.with_usage}/${sum.measurable}${sum.usage_pct == null ? '' : ` = ${sum.usage_pct}%`}${sum.tokens ? ` · token vào ${k(sum.tokens.input)} cache-đọc ${k(sum.tokens.cache_read)} cache-ghi ${k(sum.tokens.cache_write)} ra ${k(sum.tokens.output)}` : ''}`);
  },

  async lease() {
    const [act, res = 'browser'] = rest;
    if (!['acquire', 'renew', 'release', 'status'].includes(act ?? '')) die('Dùng: lease acquire|renew|release|status [tài nguyên] --holder <tên> [--gen N] [--ttl giây] [--pid N]');
    if (!RESOURCES.includes(res)) die(`Tài nguyên lạ "${res}". Có: ${RESOURCES.join(' · ')}`);
    const L = createLeases({});
    const out = (o, ok = o.ok !== false) => { console.log(flags.json ? JSON.stringify(o) : (ok ? 'ok ' : 'KHÔNG ') + JSON.stringify(o)); process.exit(ok ? 0 : 3); };
    const holder = flags.holder === true ? '' : String(flags.holder ?? '');
    if (act === 'status') { const v = L.status(res) ?? { held: false, gen: 0 }; out(v, true); }
    if (!holder) die('Thiếu --holder <tên>');
    const gen = flags.gen == null || flags.gen === true ? null : Number(flags.gen);
    const ttl = Number(flags.ttl) > 0 ? Number(flags.ttl) : undefined;
    if (act === 'acquire') out(L.acquire(res, { holder, run_id: flags.run === true ? null : (flags.run ?? null), pid: Number(flags.pid) > 0 ? Number(flags.pid) : null, ttl_s: ttl }));
    if (act === 'renew') { if (gen == null) die('Thiếu --gen N (số fencing nhận lúc acquire)'); out(L.renew(res, { holder, gen, ttl_s: ttl })); }
    out(L.release(res, { holder, gen }));
  },
};

if (!cmds[cmd]) die(`Lệnh lạ "${cmd}". Có: ${Object.keys(cmds).join(' · ')}`);
try { await cmds[cmd](); } catch (e) { die(`lỗi: ${e?.message ?? e}`, e?.auth ? 2 : 1); }
