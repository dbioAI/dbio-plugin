/**
 * lib/agentd/roster.mjs — #1075: roster nhân viên của MÁY lấy từ máy chủ (nguồn chuẩn), xác thực bằng KHOÁ MÁY.
 * Khoá máy: biến DBIO_MACHINE_KEY, hoặc tệp ~/.dbio/machine.key (một dòng; tuỳ chọn JSON {key, mcp_url, store_id}). KHÔNG nằm trong agentd.json; không bao giờ in/log.
 * Hình dạng #1074: machine_roster ⇒ {machine_id, staff:[{id,name,role,team_id,agent:cli|desktop,model,min_model,enabled,duty,session_ref?,key_id?}], revision}.
 * Hàm thuần + IO mỏng; test thay được qua tham số.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SAFE_NAME } from './config.mjs';

export const DEFAULT_MCP_URL = 'https://mcp.dbio.vn/mcp';
export const machineKeyFile = () => process.env.DBIO_MACHINE_KEY_FILE || join(homedir(), '.dbio', 'machine.key');
export const rosterCacheFile = () => process.env.DBIO_AGENTD_ROSTER_CACHE || join(homedir(), '.dbio', 'agentd-roster.json');
export const staffKeyDir = () => process.env.DBIO_STAFF_KEYS_DIR || join(homedir(), '.dbio', 'staff-keys');
export const staffKeyPath = (name, dir = staffKeyDir()) => join(dir, `${String(name).replace(/[^\p{L}\p{N}_-]/gu, '_')}.json`);
export const MACHINE_KEY_HELP = 'chưa có khoá máy — dash › Thêm máy › sao khoá, lưu MỘT dòng vào ~/.dbio/machine.key (hoặc đặt biến DBIO_MACHINE_KEY). Khi có khoá, daemon tự nạp lại ở nhịp dò kế.';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };

/** ⇒ {key, mcp_url, store_id?, source} | null. Biến môi trường thắng tệp. Tệp: một dòng khoá thô, hoặc JSON. */
export function loadMachineKey({ env = process.env, file = machineKeyFile(), fallbackMcp = null } = {}) {
  let key = null; let meta = {}; let source = null;
  if (env.DBIO_MACHINE_KEY && String(env.DBIO_MACHINE_KEY).trim()) { key = String(env.DBIO_MACHINE_KEY).trim(); source = 'env'; }
  else if (existsSync(file)) {
    let txt = ''; try { txt = readFileSync(file, 'utf8').replace(/^﻿/, '').trim(); } catch { return null; }
    if (txt.startsWith('{')) { try { const j = JSON.parse(txt); key = String(j.key ?? '').trim(); meta = j; } catch { return null; } } else key = txt.split(/\r?\n/)[0].trim();
    source = 'file';
  }
  if (!key || key.length < 16) return null;
  const fb = typeof fallbackMcp === 'string' ? { mcp_url: fallbackMcp } : (fallbackMcp ?? {});
  const mcp_url = env.DBIO_MCP_URL || meta.mcp_url || fb.mcp_url || DEFAULT_MCP_URL;
  const store_id = meta.store_id ?? fb.store_id;
  return { key, mcp_url, ...(store_id != null ? { store_id } : {}), source };
}

/** mcp_url + store_id của một khoá nhân viên có sẵn (khoá máy cùng máy chủ) — thiếu ⇒ null. */
export function mcpFromStaffKeys(dir = staffKeyDir()) {
  try { for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && !/\.(alive|queue|seen|touched|outbox)\.json$/.test(x))) { const j = readJson(join(dir, f)); if (j?.mcp_url) return { mcp_url: j.mcp_url, ...(j.store_id != null ? { store_id: j.store_id } : {}) }; } } catch { /* chưa có thư mục */ }
  return null;
}

/** Gọi MCP bằng khoá máy (cùng giao thức client()). ⇒ đối tượng JSON; lỗi ⇒ ném (401/403 ⇒ e.auth). */
export async function machineCall(mk, tool, args, fetchImpl = fetch) {
  const res = await fetchImpl(mk.mcp_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mk.key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: { ...(mk.store_id ? { store_id: mk.store_id } : {}), ...args } } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) { const e = new Error(`khoá máy bị từ chối (HTTP ${res.status})`); e.auth = true; throw e; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.text();
  const line = raw.trimStart().startsWith('{') ? raw : (raw.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
  let rpc; try { rpc = JSON.parse(line); } catch { throw new Error('phản hồi không đọc được'); }
  if (rpc.error) throw new Error(`rpc: ${rpc.error.message ?? 'lỗi'}`);
  let r; try { r = JSON.parse(rpc.result?.content?.[0]?.text ?? '{}'); } catch { r = {}; }
  if (r.success === false) { const e = new Error(`từ chối: ${r.error ?? r.message ?? 'lỗi'}${r.code ? ` [${r.code}]` : ''}`); e.code = r.code; throw e; }
  return r;
}

/** Roster máy chủ ⇒ {revision, staff:[…đã lọc]}; bỏ mục sai dạng. */
export function normalizeRoster(r) {
  const staff = (Array.isArray(r?.staff) ? r.staff : []).filter((s) => s && typeof s === 'object' && SAFE_NAME.test(String(s.name ?? '')));
  return { machine_id: r?.machine_id ?? null, revision: r?.revision ?? null, staff };
}

/** Một mục roster ⇒ adapter. MẶC ĐỊNH claude-cli; claude-desktop CHỈ khi agent: desktop VÀ có session_ref. codex/hermes giữ nguyên. enabled=false ⇒ null. */
export function adapterForRosterEntry(s) {
  if (s.enabled === false) return null;
  const agent = String(s.agent ?? 'cli').toLowerCase();
  if (agent === 'desktop' || agent === 'claude_desktop') return s.session_ref ? 'claude-desktop' : 'claude-cli';
  if (agent === 'codex' || agent === 'hermes') return agent;
  return 'claude-cli'; // cli | claude | claude_code | lạ ⇒ headless
}

/** roster.staff ⇒ { <tên>: {adapter, session?, model?, min_model?, role?, staff_id?, duty?, rostered: true} } */
export function rosterToStaff(roster) {
  const out = {};
  for (const s of normalizeRoster(roster).staff) {
    const adapter = adapterForRosterEntry(s); if (!adapter) continue;
    out[s.name] = { adapter, rostered: true, ...(adapter === 'claude-desktop' && s.session_ref ? { session: String(s.session_ref) } : {}), ...(s.model ? { model: String(s.model) } : {}), ...(s.min_model ? { min_model: String(s.min_model) } : {}), ...(s.id != null ? { staff_id: s.id } : {}), ...(s.role ? { role: String(s.role) } : {}), ...(s.duty != null ? { duty: s.duty } : {}) };
  }
  return out;
}

export function readRosterCache(file = rosterCacheFile()) { const j = readJson(file); return j && Array.isArray(j.staff) ? j : null; }
export function writeRosterCache(roster, file = rosterCacheFile()) { try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify({ ...normalizeRoster(roster), cached_at: new Date().toISOString() })); renameSync(`${file}.tmp`, file); } catch { /* cache phụ */ } }

/** Ghi tệp khoá nhân viên (quyền chỉ người dùng). KHÔNG trả/ghi log giá trị khoá. */
export function writeStaffKey(name, { key, mcp_url, store_id }, dir = staffKeyDir()) {
  const f = staffKeyPath(name, dir); mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify({ who: name, ...(store_id != null ? { store_id } : {}), mcp_url, key }, null, 2), { mode: 0o600 });
  renameSync(`${f}.tmp`, f); try { chmodSync(f, 0o600); } catch { /* Windows */ } return f;
}
export function removeStaffKey(name, dir = staffKeyDir()) { try { unlinkSync(staffKeyPath(name, dir)); return true; } catch { return false; } }
export const hasStaffKey = (name, dir = staffKeyDir()) => existsSync(staffKeyPath(name, dir));

/**
 * Đồng bộ khoá theo roster: nhân viên mới thiếu tệp khoá ⇒ staff_key_issue (khoá máy) ghi tệp; nhân viên từng do roster quản (prevNames) mà nay vắng ⇒ xoá tệp khoá.
 * ⇒ {issued:[tên], revoked:[tên], failed:[{name, error}]}. issueFn(name, id) ⇒ {key, mcp_url?, store_id?} — giá trị khoá chỉ đi từ issueFn vào tệp.
 */
export async function syncStaffKeys({ staff, prevNames = [], issueFn, dir = staffKeyDir(), mcpDefault = {}, hasKey = (n) => hasStaffKey(n, dir) }) {
  const out = { issued: [], revoked: [], failed: [] };
  for (const [name, e] of Object.entries(staff)) {
    if (hasKey(name)) continue;
    try { const r = await issueFn(name, e.staff_id); if (!r?.key) throw new Error('máy chủ không trả khoá'); writeStaffKey(name, { key: r.key, mcp_url: r.mcp_url ?? mcpDefault.mcp_url ?? DEFAULT_MCP_URL, store_id: r.store_id ?? mcpDefault.store_id }, dir); out.issued.push(name); }
    catch (err) { out.failed.push({ name, error: String(err?.message ?? err).slice(0, 160) }); }
  }
  for (const n of prevNames) if (!(n in staff) && removeStaffKey(n, dir)) out.revoked.push(n);
  return out;
}
