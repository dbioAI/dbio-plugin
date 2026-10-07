/**
 * lib/agentd/config.mjs — cấu hình daemon dbio-agentd: MỘT tệp JSON (~/.dbio/agentd.json, đổi bằng DBIO_AGENTD_CONFIG). Hàm thuần + IO mỏng.
 * {
 *   "version": 1,
 *   "staff": { "<tên nhân viên>": { "adapter": "claude-cli|claude-desktop|codex|hermes|command|<tên adapter cắm thêm>", "session": "<id phiên>", "cwd": "<thư mục>", "secretary": false, … tuỳ adapter } },
 *   "discover": { "enabled": false, "as": "<tên có khoá để hỏi staff_list>", "every_min": 10 },   // tự thêm nhân viên có runtime.machine = máy này
 *   "defaults": { "coalesce_ms": 3000, "listener_confirm_s": 60, "wake_timeout_s": 900, "retry_s": 30, "adapter": null },
 *   "rules": { "sweep": { "enabled": false, "as": "<tên thư ký>", "every_min": 15 } },        // luật nhắc: thẻ im · chờ chủ · mất nhịp · 2 thẻ (mã, 0 token)
 *   "adapter_modules": ["<đường dẫn .mjs>"]                                                  // adapter cắm thêm: export default {name, wake(ctx)}
 * }
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const configFile = () => process.env.DBIO_AGENTD_CONFIG || join(homedir(), '.dbio', 'agentd.json');

export const DEFAULTS = Object.freeze({ coalesce_ms: 3000, listener_confirm_s: 60, redeliver_after_min: 10, relay_to: null, first_run: 'fresh', fresh_keep_hours: 6, max_relays: 3, wake_timeout_s: 900, retry_s: 30, adapter: null });
export const SAFE_NAME = /^[\p{L}\p{N} _.-]{1,60}$/u;
export const AGENT_TO_ADAPTER = Object.freeze({ claude_code: 'claude-cli', claude: 'claude-cli', claude_desktop: 'claude-desktop', codex: 'codex', hermes: 'hermes' });

/** Chuẩn hoá + kiểm. ⇒ {config, errors: [chuỗi]}. Không ném lỗi: daemon báo rõ rồi bỏ nhân viên sai. */
export function normalizeConfig(raw) {
  const errors = [];
  const r = raw && typeof raw === 'object' ? raw : {};
  const cfg = {
    version: 1,
    staff: {},
    discover: { enabled: false, as: null, every_min: 10, ...(r.discover ?? {}) },
    defaults: { ...DEFAULTS, ...(r.defaults ?? {}) },
    rules: { sweep: { enabled: false, as: null, every_min: 15, ...(r.rules?.sweep ?? {}) } },
    adapter_modules: Array.isArray(r.adapter_modules) ? r.adapter_modules.map(String) : [],
  };
  for (const [name, e] of Object.entries(r.staff ?? {})) {
    if (!e || typeof e !== 'object') { errors.push(`staff.${name}: phải là đối tượng`); continue; }
    const adapter = e.adapter ?? cfg.defaults.adapter;
    if (!adapter) { errors.push(`staff.${name}: thiếu "adapter"`); continue; }
    cfg.staff[name] = { ...e, adapter };
  }
  for (const k of ['coalesce_ms', 'listener_confirm_s', 'redeliver_after_min', 'wake_timeout_s', 'retry_s']) if (!(Number(cfg.defaults[k]) >= 0)) { errors.push(`defaults.${k}: phải là số ≥ 0`); cfg.defaults[k] = DEFAULTS[k]; }
  if (cfg.rules.sweep.enabled && !cfg.rules.sweep.as) { errors.push('rules.sweep.as: thiếu tên nhân viên có khoá (thư ký) — luật quét bị tắt'); cfg.rules.sweep.enabled = false; }
  if (cfg.discover.enabled && !cfg.discover.as) { errors.push('discover.as: thiếu tên nhân viên có khoá — tự dò bị tắt'); cfg.discover.enabled = false; }
  return { config: cfg, errors };
}

export function loadConfig(file = configFile()) {
  if (!existsSync(file)) return { ...normalizeConfig({}), file, exists: false };
  let raw; try { raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { return { ...normalizeConfig({}), errors: [`${file}: JSON hỏng (${e.message})`], file, exists: true }; }
  return { ...normalizeConfig(raw), file, exists: true };
}

export function saveConfig(raw, file = configFile()) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, `${JSON.stringify(raw, null, 2)}\n`); renameSync(`${file}.tmp`, file); }

export const SAMPLE = {
  version: 1,
  staff: { '<tên nhân viên>': { adapter: 'claude-cli', session: '<id phiên claude (--resume)>', cwd: '<thư mục làm việc>' } },
  discover: { enabled: false, as: '<tên nhân viên có khoá>', every_min: 10 },
  defaults: { coalesce_ms: 3000, listener_confirm_s: 60, wake_timeout_s: 900 },
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
