#!/usr/bin/env node
/**
 * dbio-agentd — daemon NHẬN VIỆC cho nhân viên AI trên máy này (thay phiên AI thư ký): giữ kết nối kênh đẩy `staff:` bằng khoá riêng từng nhân viên,
 * có việc ⇒ gọi ADAPTER đánh thức đúng phiên (Claude CLI · Claude Desktop · Codex · Hermes · lệnh tuỳ chỉnh). 0 token LLM cho phần canh.
 *
 *   run                      chạy daemon (dịch vụ gọi lệnh này)
 *   install [--dry]          cài thành dịch vụ người dùng: launchd (macOS) · Task Scheduler (Windows) · systemd --user (Linux); tự chạy lại khi thoát
 *   uninstall [--dry]        gỡ dịch vụ (giữ cấu hình + log)
 *   status [--json]          dịch vụ có đang chạy? từng nhân viên: kết nối · số lần thức · lỗi cuối
 *   init [--force]           ghi agentd.json TỐI GIẢN (~/.dbio/agentd.json): nhân viên lấy từ máy chủ bằng khoá máy ~/.dbio/machine.key (#1075)
 *   migrate [--dry]          tệp cũ ⇒ THÊM staff_defaults (cwd/args chung) + discover.enabled; staff[] GIỮ NGUYÊN để daemon bản cũ vẫn chạy đủ cờ (sao lưu .bak-pre1075)
 *   roster [--json]          xem roster máy chủ cấp cho khoá máy này (không in khoá)
 *   wake <tên> [lời nhắc]    thử đánh thức một nhân viên qua adapter đã cấu hình (kiểm cấu hình mà không chờ việc thật)
 *   adapters                 danh sách adapter
 *   runs [--month YYYY-MM] [--staff <tên>] [--limit N] [--json]   sổ Run do agentd ĐO (model thật, tài khoản, token vào/cache/ra từ CLI; thiếu ⇒ trống, không 0) + tỉ lệ run có usage thật
 *   lease acquire|renew|release|status <tài nguyên> …   lease cả máy cho tài nguyên chia sẻ (browser = Chrome thật; repo-<tên> = 1 lượt mutate/repo; merge-<tên> = hàng gộp), 1 chủ/lúc; acquire --holder <tên> [--ttl 300] [--pid N]; renew/release --holder <tên> --gen N
 *   worktree <sổ#thẻ> --repo <tên|đường dẫn>[,…] [--json]   (#1062) tạo/dùng lại worktree RIÊNG của thẻ (<gốc>/.wt/<repo>-t<id>, nhánh wt/<repo>-t<id>) — idempotent, in trạng thái bền (sha, file dở)
 *   merge <sổ#thẻ> --repo <tên|đường dẫn>[,…] [--test "<lệnh>" | --no-test] [--strategy pick|rebase|merge] [--json]   (#1062) gộp worktree thẻ về main TUẦN TỰ: hàng chờ + lease → fetch → cherry-pick lên origin/main (mặc định) → test → push (không --force); xung đột/test đỏ/cây bẩn ⇒ mã 3, không ghi đè
 *
 * Cấu hình: MỘT tệp ~/.dbio/agentd.json (DBIO_AGENTD_CONFIG đổi đường dẫn) — xem README mục "Daemon dbio-agentd". Khoá: ~/.dbio/staff-keys/<tên>.json (không in, không ghi log).
 * Mã thoát: 0 ok · 1 lỗi · 2 thiếu cấu hình/khoá.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, die, helpOf, parseArgs } from '../lib/common.mjs';
import { SAMPLE, configFile, migrateConfig, saveConfig } from '../lib/agentd/config.mjs';
import { MACHINE_KEY_HELP, loadMachineKey, machineCall, machineKeyFile, mcpFromStaffKeys, normalizeRoster } from '../lib/agentd/roster.mjs';
import { adapterNames } from '../lib/agentd/adapters/index.mjs';
import { createDaemon, readStatus } from '../lib/agentd/daemon.mjs';
import { acquireInstanceLock, releaseInstanceLock } from '../lib/agentd/instance-lock.mjs';
import { installPlan } from '../lib/agentd/service.mjs';
import { ageMin } from '../lib/agentd/rules.mjs';
import { installPm2, statusPm2, uninstallPm2 } from '../lib/agentd/pm2-cli.mjs';
import { createRunStore, pidAlive, summarize } from '../lib/agentd/runs.mjs';
import { evictSameScript } from '../lib/agentd/procs.mjs';
import { createLeases, RESOURCES } from '../lib/agentd/lease.mjs';
import { mergeCard, prepareWorktree, resolveRepo } from '../lib/agentd/worktree.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2), ['--month', '--staff', '--limit', '--holder', '--gen', '--ttl', '--pid', '--run', '--repo', '--test', '--strategy']);
const [cmd, ...rest] = pos;
if (!cmd || flags.help || flags.h) die(helpOf(import.meta.url), 0);
const SCRIPT = resolve(fileURLToPath(import.meta.url));

const cmds = {
  async run() {
    // #1060 (c): một daemon / máy — bản thứ hai ĐỨNG CHỜ (không thoát để wrapper/pm2 không quay vòng), nhận việc khi bản kia chết
    let lk = acquireInstanceLock({ statusRead: readStatus }); let warned = 0;
    if (!lk.ok && process.env.DBIO_AGENTD_NO_EVICT !== '1') { // #1060 (2): daemon cũ CÙNG script ⇒ giết (thay vì chờ, 16/10 mất 2h không có lượt); script khác ⇒ vẫn chờ
      const ev = await evictSameScript({ script: SCRIPT, alive: pidAlive }).catch(() => ({ killed: [], stuck: [] }));
      if (ev.killed.length) console.error(`[agentd] đã dừng daemon cũ cùng script (pid ${ev.killed.join(',')})${ev.stuck.length ? ` — còn kẹt ${ev.stuck.join(',')}` : ''}.`);
      lk = acquireInstanceLock({ statusRead: readStatus });
    }
    while (!lk.ok) {
      if (Date.now() - warned > 300_000) { warned = Date.now(); console.error(`[agentd] đã có daemon khác đang chạy (pid ${lk.owner}) — bản này đứng chờ, KHÔNG nhận việc (tránh 2 Run / 1 @mention).`); }
      await new Promise((r) => setTimeout(r, 10_000)); lk = acquireInstanceLock({ statusRead: readStatus });
    }
    process.on('exit', () => releaseInstanceLock());
    const clients = new Map();
    const makeClient = (n) => { if (!clients.has(n)) clients.set(n, client(n, { throwAuth: true })); return clients.get(n); };
    const d = createDaemon({ makeClient, forgetClient: (n) => clients.delete(n) });
    const r = await d.start();
    if (!r.staff.length) console.error('[agentd] chưa có nhân viên nào để nghe — roster lấy từ máy chủ bằng khoá máy (' + machineKeyFile() + '); daemon vẫn chạy và tự dò lại mỗi nhịp.');
    const bye = () => { d.stop(); d.writeStatus(); process.exit(0); };
    // #1060 (3): SIGTERM (pm2 reload/stop) ⇒ DRAIN trước: không nhận lượt mới, chờ lượt đang chạy (tối đa drain_wait_s, mặc định 600s) rồi mới thoát; restart do supervisor NGOÀI lượt, cấm tự restart từ trong lượt
    let byeOnce = false;
    process.on('SIGINT', bye); process.on('SIGTERM', async () => { if (byeOnce) return; byeOnce = true; try { await d.drain(Number(process.env.DBIO_AGENTD_DRAIN_S ?? 600) * 1000); } catch { /* thoát dù lỗi */ } bye(); });
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
    if (!existsSync(configFile())) { saveConfig(SAMPLE); console.log('ok đã ghi ' + configFile() + ' tối giản (nhân viên lấy từ máy chủ).'); }
    if (!loadMachineKey({ fallbackMcp: mcpFromStaffKeys() })) console.error('[agentd] 🔴 ' + MACHINE_KEY_HELP);
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
    if (st?.roster) console.log('  roster: ' + st.roster.count + ' người · nguồn ' + st.roster.source + (st.roster.revision != null ? ' · rev ' + st.roster.revision : '') + (st.roster.machine_key ? '' : ' · 🔴 chưa có khoá máy') + (st.roster.error ? ' · ⚠️ ' + st.roster.error : ''));
    if (alive && st?.slots) console.log(`  slot: ${st.slots.used}/${st.slots.max} đang dùng${(st.runs ?? []).length ? ` · run mở: ${st.runs.map((r) => `${r.staff}${r.card ? ` ${r.card}` : ''}${r.slot_returned ? ' (đã trả slot)' : ''}`).join(', ')}` : ''}`);
    for (const [n, s] of Object.entries(st?.staff ?? {})) console.log(`  ${n} · ${s.adapter}${s.discovered ? ' (tự dò)' : ''} · ${s.connected ? `nối ${s.transport}` : 'MẤT KẾT NỐI'} · thức ${s.wakes} lần${s.last_wake_at ? ` (cuối ${ageMin(s.last_wake_at)}p trước)` : ''}${s.queued ? ` · chờ ${s.queued}` : ''}${s.hold ? ` · ⏸ hoãn: ${s.hold}` : ''}${s.last_error ? ` · ⚠️ ${s.last_error}` : ''}`);
    if (!Object.keys(st?.staff ?? {}).length && alive) console.log('  (chưa có nhân viên nào — xem cấu hình)');
  },

  async init() {
    const f = configFile();
    if (existsSync(f) && !flags.force) die(`${f} đã có (dùng --force để ghi đè).`);
    mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(SAMPLE, null, 2)}\n`);
    console.log('ok đã ghi ' + f + ' (tối giản). Đặt khoá máy vào ' + machineKeyFile() + ' (một dòng) — nhân viên tự lấy từ máy chủ; kiểm: dbio-agentd roster');
  },

  async roster() {
    const mk = loadMachineKey({ fallbackMcp: mcpFromStaffKeys() }); if (!mk) die('🔴 ' + MACHINE_KEY_HELP, 2);
    const r = normalizeRoster(await machineCall(mk, 'ai_character', { action: 'machine_roster' }).then((x) => x.roster ?? x));
    if (flags.json) { console.log(JSON.stringify(r)); return; }
    console.log('máy ' + (r.machine_id ?? '?') + ' · revision ' + (r.revision ?? '?') + ' · ' + r.staff.length + ' nhân viên');
    for (const s of r.staff) console.log('  ' + s.name + ' · ' + (s.agent ?? 'cli') + (s.enabled === false ? ' (tắt)' : '') + (s.model ? ' · ' + s.model : '') + (s.session_ref ? ' · có session_ref' : ''));
  },

  async migrate() {
    const f = configFile(); if (!existsSync(f)) die(f + ' chưa có — chạy init.');
    const mk = loadMachineKey({ fallbackMcp: mcpFromStaffKeys() }); if (!mk) die('🔴 ' + MACHINE_KEY_HELP + ' (migrate chỉ bỏ staff khai tay SAU KHI roster máy chủ khớp)', 2);
    const roster = normalizeRoster(await machineCall(mk, 'ai_character', { action: 'machine_roster' }).then((x) => x.roster ?? x));
    if (!roster.staff.length) die('Roster máy chủ rỗng — giữ nguyên tệp cũ.', 1);
    const raw = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    const m = migrateConfig(raw, roster.staff.map((s) => s.name));
    console.log('roster ' + roster.staff.length + ' người · chỉ thêm staff_defaults (staff[] GIỮ NGUYÊN, tương thích bản cũ) · ghi đè cục bộ: ' + (m.kept.join(', ') || '(không)'));
    if (flags.dry) { console.log(JSON.stringify(m.raw, null, 2)); return; }
    copyFileSync(f, f + '.bak-pre1075'); saveConfig(m.raw, f); console.log('ok đã ghi ' + f + ' (bản cũ: ' + f + '.bak-pre1075). Daemon tự nạp lại ở nhịp config_reload.');
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
    if (!RESOURCES.includes(res) && !/^(repo|merge)-[a-z0-9_-]{1,26}$/.test(res)) die(`Tài nguyên lạ "${res}". Có: ${RESOURCES.join(' · ')}`);
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
  /** #1062: worktree / merge theo thẻ — repo = tên dưới $DBIO_ROOT hoặc đường dẫn repo git. */
  async worktree() { for (const { repo, card } of repoArgs()) { const w = prepareWorktree({ repo, card }); printWt(w, repo); if (!w.ok) process.exitCode = 3; } },
  async merge() {
    const strategy = ['merge', 'rebase'].includes(flags.strategy) ? flags.strategy : 'pick';
    const test = flags['no-test'] ? null : (typeof flags.test === 'string' ? flags.test : undefined);
    for (const { repo, card } of repoArgs()) {
      const r = await mergeCard({ repo, card, strategy, test, holder: `merge:${card}:${process.pid}` });
      if (flags.json) console.log(JSON.stringify({ repo: repo.name, ...r }));
      else console.log(`${r.ok ? 'ok' : 'KHÔNG'} ${repo.name} ${card}: ${r.status}${r.sha ? ` · ${r.sha.slice(0, 7)}` : ''}${r.detail ? ` — ${r.detail}` : ''}${r.files?.length ? ` [${r.files.join(', ')}]` : ''}${r.tail ? `\n${r.tail}` : ''}`);
      if (!r.ok) { process.exitCode = 3; break; } // repo sau không gộp khi repo trước hỏng
    }
  },
};

function repoArgs() {
  const card = rest[0]; if (!/^\d+#\d+$/.test(String(card ?? ''))) die('Thiếu <sổ#thẻ> (vd 162801#1062)');
  if (typeof flags.repo !== 'string') die('Thiếu --repo <tên|đường dẫn>[,…]');
  return flags.repo.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const name = x.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    const repo = /[\\/]/.test(x) ? resolveRepo(name, { repos: { [name]: x } }) : resolveRepo(x);
    if (!repo) die(`Không thấy repo git "${x}" (tên dưới DBIO_ROOT=${process.env.DBIO_ROOT ?? '?'} hoặc đường dẫn)`);
    return { repo, card };
  });
}
function printWt(w, repo) {
  if (flags.json) return console.log(JSON.stringify({ repo: repo.name, ...w }));
  if (!w.ok) return console.log(`KHÔNG ${repo.name}: ${w.detail}`);
  const s = w.state ?? {};
  console.log(`ok ${repo.name}: ${w.path} · nhánh ${w.branch} · HEAD ${String(s.head ?? '?').slice(0, 7)} · ${s.dirty?.length ? `${s.dirty.length} file dở` : 'sạch'} · +${s.ahead ?? '?'}/-${s.behind ?? '?'} · ${w.created ? 'MỚI tạo' : w.reattached ? 'gắn lại nhánh' : 'dùng lại'} · node_modules ${w.node_modules}`);
}

if (!cmds[cmd]) die(`Lệnh lạ "${cmd}". Có: ${Object.keys(cmds).join(' · ')}`);
try { await cmds[cmd](); } catch (e) { die(`lỗi: ${e?.message ?? e}`, e?.auth ? 2 : 1); }
