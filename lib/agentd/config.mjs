/**
 * lib/agentd/config.mjs — cấu hình daemon dbio-agentd: MỘT tệp JSON (~/.dbio/agentd.json, đổi bằng DBIO_AGENTD_CONFIG). Hàm thuần + IO mỏng.
 * {
 *   "version": 1,
 *   "staff": { "<tên nhân viên>": { "adapter": "claude-cli|…", "cwd": "<thư mục>", … } },      // #1075: CHỈ còn GHI ĐÈ cục bộ (tuỳ chọn) — danh sách nhân viên lấy từ máy chủ (machine_roster)
 *   "staff_defaults": { "cwd": "<thư mục>", "args": [...], "max_context_tokens": 80000 },    // áp cho MỌI nhân viên từ roster (cấu hình máy)
 *   "discover": { "enabled": true, "every_min": 10, "as": null },   // #1075: BẬT mặc định; khoá MÁY (~/.dbio/machine.key | DBIO_MACHINE_KEY) gọi machine_roster. "as" = đường lui cũ (staff_list bằng khoá nhân viên) khi chưa có khoá máy
 *   "defaults": { "coalesce_ms": 3000, "listener_confirm_s": 60, "wake_timeout_s": 14400, "retry_s": 30, "adapter": null },
 *   "rules": { "sweep": {…}, "hygiene": { "enabled": true, "every_min": 10, "idle_min": 15 } },   // #965 hygiene: phiên rảnh quá ngưỡng ⇒ cầu clear; phiên trống còn thẻ ⇒ cầu nạp vai. Tắt từng phiên: "auto_compact": false        // luật nhắc: thẻ im · chờ chủ · mất nhịp · 2 thẻ (mã, 0 token)
 *   "adapter_modules": ["<đường dẫn .mjs>"]                                                  // adapter cắm thêm: export default {name, wake(ctx)}
 * }
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const configFile = () => process.env.DBIO_AGENTD_CONFIG || join(homedir(), '.dbio', 'agentd.json');

export const DEFAULTS = Object.freeze({ coalesce_ms: 3000, listener_confirm_s: 60, redeliver_after_min: 10, relay_to: null, first_run: 'fresh', fresh_keep_hours: 6, max_relays: 3, wake_timeout_s: 14400, retry_s: 30, adapter: 'claude-cli', auto_compact: true, compact_retry_min: 15, compact_max_tries: 3, relay_card_min: 60, skip_idle_blank: true, max_slots: 3, lease_s: 90 });
export const SAFE_NAME = /^[\p{L}\p{N} _.-]{1,60}$/u;
export const AGENT_TO_ADAPTER = Object.freeze({ claude_code: 'claude-cli', claude: 'claude-cli', claude_desktop: 'claude-desktop', codex: 'codex', hermes: 'hermes' });

/** Chuẩn hoá + kiểm. ⇒ {config, errors: [chuỗi]}. Không ném lỗi: daemon báo rõ rồi bỏ nhân viên sai. */
export function normalizeConfig(raw) {
  const errors = [];
  const r = raw && typeof raw === 'object' ? raw : {};
  const cfg = {
    version: 1,
    staff: {},
    discover: { enabled: true, as: null, every_min: 10, ...(r.discover ?? {}) },
    staff_defaults: r.staff_defaults && typeof r.staff_defaults === 'object' ? { ...r.staff_defaults } : {},
    defaults: { ...DEFAULTS, ...(r.defaults ?? {}) },
    rules: { sweep: { enabled: false, as: null, every_min: 15, ...(r.rules?.sweep ?? {}) }, hygiene: { enabled: true, every_min: 10, idle_min: 15, reload_every_min: 60, ...(r.rules?.hygiene ?? {}) } },
    adapter_modules: Array.isArray(r.adapter_modules) ? r.adapter_modules.map(String) : [],
    accounts: Array.isArray(r.accounts) ? r.accounts : [],   // #1060 (5): [{label, config_dir, priority?, reserved_for_owner?}] — mỗi tài khoản Max một CLAUDE_CONFIG_DIR
  };
  for (const [name, e] of Object.entries(r.staff ?? {})) {
    if (!e || typeof e !== 'object') { errors.push(`staff.${name}: phải là đối tượng`); continue; }
    cfg.staff[name] = { ...e }; // #1075: adapter không bắt buộc — thiếu ⇒ lấy từ roster máy chủ, rồi defaults.adapter (claude-cli) — xem effectiveStaff
  }
  for (const k of ['coalesce_ms', 'listener_confirm_s', 'redeliver_after_min', 'wake_timeout_s', 'retry_s', 'compact_retry_min', 'compact_max_tries', 'relay_card_min', 'max_slots', 'lease_s']) if (!(Number(cfg.defaults[k]) >= 0)) { errors.push(`defaults.${k}: phải là số ≥ 0`); cfg.defaults[k] = DEFAULTS[k]; }
  if (cfg.rules.sweep.enabled && !cfg.rules.sweep.as) { errors.push('rules.sweep.as: thiếu tên nhân viên có khoá (thư ký) — luật quét bị tắt'); cfg.rules.sweep.enabled = false; }
  return { config: cfg, errors };
}

export function loadConfig(file = configFile()) {
  if (!existsSync(file)) return { ...normalizeConfig({}), file, exists: false };
  let raw; try { raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { return { ...normalizeConfig({}), errors: [`${file}: JSON hỏng (${e.message})`], file, exists: true }; }
  const n = normalizeConfig(raw);
  n.errors.push(...applyManifests(n.config));
  return { ...n, file, exists: true };
}

export const manifestDir = () => process.env.DBIO_STAFF_MANIFEST_DIR || join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '..', 'dbio-internal', 'playbooks', 'staff');

/** #1045: danh tính = manifest staff/<tên>.json (git). Gắn identity + mặc định cwd/model; phiên/tài khoản trong agentd.json chỉ là cấu hình máy. Không có thư mục manifest ⇒ bỏ qua. */
export function applyManifests(cfg, dir = manifestDir()) {
  const errors = [];
  if (!existsSync(dir)) return errors;
  for (const [name, e] of Object.entries(cfg.staff)) {
    const f = join(dir, `${name.replace(/[\\/:*?"<>|]/g, '_')}.json`);
    let m = null;
    try { m = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')) : null; } catch { errors.push(`manifest ${name}: JSON hỏng`); continue; }
    if (!m) { errors.push(`staff.${name}: không có manifest (${dir}) — danh tính chưa khai báo`); continue; }
    e.identity = { staff_id: m.staff_id, role_key: m.role_key, rules_version: m.rules_version };
    e.cwd ??= m.runtime?.cwd; e.model ??= m.runtime?.model;
  }
  return errors;
}

export function saveConfig(raw, file = configFile()) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, `${JSON.stringify(raw, null, 2)}\n`); renameSync(`${file}.tmp`, file); }

/** #1075: agentd.json TỐI GIẢN — khoá máy ở ~/.dbio/machine.key, nhân viên lấy từ máy chủ. */
export const SAMPLE = {
  version: 1,
  staff_defaults: { cwd: '<thư mục làm việc>' },
  discover: { enabled: true, every_min: 10 },
  defaults: { coalesce_ms: 3000, listener_confirm_s: 60, wake_timeout_s: 14400 },
  rules: { sweep: { enabled: false, as: '<tên thư ký>', every_min: 15 } },
};

/** staff_list.staff[] ⇒ { <tên>: {adapter, session, discovered: true} } cho nhân viên có runtime.machine = máy này và có adapter hiểu được. */
export function discoverFromStaffList(staff, machine) {
  const out = {};
  const norm = (s) => String(s ?? '').toLowerCase();
  for (const s of staff ?? []) {
    const rt = s.runtime ?? {};
    if (!s.name || !SAFE_NAME.test(String(s.name)) || norm(rt.machine) !== norm(machine)) continue; // tên từ máy chủ đi vào lời nhắc/`--as "…"` ⇒ chỉ nhận ký tự an toàn
    let adapter = AGENT_TO_ADAPTER[norm(rt.agent)];
    if (adapter === 'claude-cli' && String(rt.session_ref ?? '').startsWith('local_')) adapter = 'claude-desktop'; // phiên mở trong ứng dụng Claude
    if (!adapter) continue;
    out[s.name] = { adapter, ...(rt.session_ref ? { session: String(rt.session_ref) } : {}), discovered: true };
  }
  return out;
}

/** #1096: trần ngữ cảnh MẶC ĐỊNH của NV claude_desktop (phiên ghim tốn token hơn) — quá ⇒ agentd cầu dọn (checkpoint + clear) trước khi giao lượt mới. */
export const DESKTOP_MAX_CONTEXT = 150_000;

/** #1075: gộp roster máy chủ + staff_defaults (cấu hình máy) + ghi đè cục bộ cfg.staff. Thứ tự thắng: cục bộ > roster > staff_defaults > defaults.adapter.
 *  #1096: NV claude_desktop không tự khai max_context_tokens cục bộ ⇒ defaults.desktop_max_context_tokens (mặc định 150k) — thắng staff_defaults (thường đặt cho CLI). */
export function effectiveStaff(cfg, rostered = {}) {
  const out = {};
  for (const n of new Set([...Object.keys(rostered), ...Object.keys(cfg.staff)])) {
    const e = { ...(cfg.staff_defaults ?? {}), ...(rostered[n] ?? {}), ...(cfg.staff[n] ?? {}) };
    e.adapter ??= cfg.defaults.adapter; if (!e.adapter) continue;
    if ((e.runtime === 'claude_desktop' || e.adapter === 'claude-desktop') && cfg.staff[n]?.max_context_tokens == null) e.max_context_tokens = Number(cfg.defaults?.desktop_max_context_tokens ?? DESKTOP_MAX_CONTEXT);
    out[n] = e;
  }
  return out;
}

/**
 * #1075: migrate tệp cũ — TƯƠNG THÍCH NGƯỢC (17/10: bản 0.3.24 bỏ staff[] làm daemon N-1 mất args ⇒ lượt không bypassPermissions). Chỉ THÊM: staff_defaults (cwd/args/… chung) + discover.enabled.
 * staff[] GIỮ NGUYÊN (daemon cũ vẫn đọc đủ adapter/args/cwd; daemon mới coi là ghi đè cục bộ). Roster rỗng ⇒ không đụng. ⇒ {raw, dropped:[] (luôn rỗng), kept:[tên]}
 */
export function migrateConfig(raw, rosterNames) {
  const r = JSON.parse(JSON.stringify(raw ?? {})); const names = new Set(rosterNames ?? []);
  if (!names.size) return { raw: r, dropped: [], kept: Object.keys(r.staff ?? {}) };
  const rostered = Object.entries(r.staff ?? {}).filter(([n]) => names.has(n)).map(([, e]) => e);
  const common = {};
  for (const k of ['cwd', 'args', 'sessions_dir', 'max_context_tokens']) { const v = rostered.map((e) => JSON.stringify(e[k])); if (v.length && v[0] !== undefined && v.every((x) => x === v[0])) common[k] = JSON.parse(v[0]); }
  r.staff_defaults = { ...common, ...(r.staff_defaults ?? {}) };
  r.discover = { ...(r.discover ?? {}), enabled: true };
  return { raw: r, dropped: [], kept: Object.keys(r.staff ?? {}) };
}
