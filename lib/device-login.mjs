/**
 * lib/device-login.mjs — đăng nhập MÁY bằng MÃ THIẾT BỊ (khoá KHÔNG đi qua ngữ cảnh model). Phần logic, fetch/ghi tệp truyền vào ⇒ test được.
 *
 *   start  POST {origin}/device/start {who}            ⇒ {code, poll_secret, interval?, expires_in?}
 *   poll   POST {origin}/device/poll {code, poll_secret} ⇒ {status:'pending'} | {status:'ok', key, mcp_url, store_id?, board?} | {status:'denied'|'expired'}
 * Người/agent có quyền duyệt gọi MCP `ai_character staff_key_approve {code, who}` bằng connector; khoá sinh ở máy chủ, trả cho CLI MỘT lần.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_MCP_URL = 'https://mcp.dbio.vn/mcp';
export const originOf = (mcpUrl) => new URL(mcpUrl).origin;

/** Chỉ https; http chỉ cho máy cục bộ (thử nghiệm). Khoá đi qua mạng nên không chấp nhận http ra Internet. */
export function assertSecureUrl(mcpUrl) {
  const u = new URL(mcpUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error(`Địa chỉ MCP phải là https (nhận ${u.protocol}//${u.host})`);
  return u;
}

async function post(fetchFn, url, body) {
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`Phản hồi không đọc được (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(`${j.error ?? j.message ?? 'HTTP ' + res.status}`);
  return j;
}

export const startDevice = (fetchFn, mcpUrl, who) => post(fetchFn, `${originOf(mcpUrl)}/device/start`, { who });
export const pollDevice = (fetchFn, mcpUrl, code, pollSecret) => post(fetchFn, `${originOf(mcpUrl)}/device/poll`, { code, poll_secret: pollSecret });

/** 4 ký tự cuối — chỉ thứ duy nhất được in ra về khoá. */
export const tail4 = (key) => String(key ?? '').slice(-4);

/** Đạt khoá hợp lệ? (có key + mcp_url https) */
export function validKeyPayload(p, expectOrigin = null) {
  if (!p || typeof p.key !== 'string' || p.key.length < 16 || typeof p.mcp_url !== 'string') return false;
  try { assertSecureUrl(p.mcp_url); } catch { return false; }
  if (expectOrigin) { try { if (new URL(p.mcp_url).origin !== new URL(expectOrigin).origin) return false; } catch { return false; } }
  return true;
}

/** Ghi tệp khoá (0600 nếu hệ cho). Trả đường dẫn. KHÔNG in giá trị. */
export function saveKey(file, payload, who) {
  mkdirSync(dirname(file), { recursive: true });
  const body = { who, key: payload.key, mcp_url: payload.mcp_url, ...(payload.store_id != null ? { store_id: payload.store_id } : {}), ...(payload.board != null ? { board: payload.board } : {}) };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
  return file;
}

/**
 * Chạy cả luồng. opts: {fetchFn, mcpUrl, who, file, say(line), sleep(ms), now(), maxWaitMs=600000}.
 * ⇒ {ok:true, tail} | {ok:false, reason:'denied'|'expired'|'timeout'}.
 */
export async function deviceLogin({ fetchFn = fetch, mcpUrl = DEFAULT_MCP_URL, who, file, say = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, maxWaitMs = 600_000 }) {
  assertSecureUrl(mcpUrl);
  const s = await startDevice(fetchFn, mcpUrl, who);
  if (!s.code || !s.poll_secret) throw new Error('Máy chủ không trả mã thiết bị (chưa hỗ trợ?)');
  say(`MÃ THIẾT BỊ: ${s.code} · vai "${who}" · máy chủ ${new URL(mcpUrl).host} · đang chờ duyệt (gọi MCP ai_character staff_key_approve {code:"${s.code}", who:"${who}"} bằng connector dbio, hoặc duyệt ở dash › Nhân viên AI › Khoá MCP).`);
  const every = Math.max(1000, (Number(s.interval) || 3) * 1000);
  const t0 = now();
  while (now() - t0 < maxWaitMs) {
    await sleep(every);
    const p = await pollDevice(fetchFn, mcpUrl, s.code, s.poll_secret);
    if (p.status === 'ok') {
      if (!validKeyPayload(p, mcpUrl)) throw new Error('Máy chủ trả khoá không hợp lệ (thiếu/ngắn, không https, hoặc mcp_url khác máy chủ đã hỏi)');
      saveKey(file, p, who);
      return { ok: true, tail: tail4(p.key) };
    }
    if (p.status === 'denied' || p.status === 'expired') return { ok: false, reason: p.status };
  }
  return { ok: false, reason: 'timeout' };
}
