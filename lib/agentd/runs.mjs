/**
 * lib/agentd/runs.mjs — SỔ RUN của agentd (#1036): MỘT lần worker chạy MỘT thẻ. Số liệu do agentd ĐO (pid, thời gian, usage CLI), không do model khai.
 * Thiếu số liệu ⇒ null (TRỐNG), cấm ghi 0 giả. Sổ cục bộ: <dir>/open.json (run đang mở, ghi nguyên tử) + <dir>/runs-YYYY-MM.jsonl (mỗi dòng = ảnh chụp run, dòng cuối của run_id thắng).
 * Dạng bản ghi khớp attempt của Agent Job Board để đẩy lên máy chủ sau (#1036 pha B).
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const runsDir = () => process.env.DBIO_AGENTD_RUNS_DIR || join(homedir(), '.dbio', 'agentd-runs');
export const BEAT_MS = 30_000;       // nhịp worker
export const LOST_MS = 90_000;       // mất 90s không nhịp ⇒ mất liên lạc
export const CARD_RE = /^\d+#\d+$/;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const sumKnown = (arr) => (arr.some((x) => x != null) ? arr.reduce((a, x) => a + (x ?? 0), 0) : null);

/** Dòng JSON kết quả cuối của `claude -p --output-format json` (có thể lẫn dòng stderr phía trước) ⇒ đối tượng | null. */
export function findResultJson(out) {
  const lines = String(out ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim(); if (!l.startsWith('{')) continue;
    try { const j = JSON.parse(l); if (j && typeof j === 'object' && (j.type === 'result' || 'usage' in j || 'modelUsage' in j)) return j; } catch { /* dòng khác */ }
  }
  try { const j = JSON.parse(String(out ?? '').trim()); if (j && typeof j === 'object') return j; } catch { /* không phải JSON */ }
  return null;
}

/**
 * Đầu ra CLI ⇒ {session_id, models:[{model,input,output,cache_read,cache_write,cost_usd}], tokens:{input,cache_read,cache_write,output}|null, cost_usd|null, is_error, terminal_reason, error_code, num_turns, duration_ms}.
 * tokens CHỈ lấy từ modelUsage (model THỰC đã chạy); modelUsage rỗng (lỗi API trước khi gọi được model) ⇒ tokens null chứ KHÔNG 0.
 * Đầu ra không có JSON kết quả (codex/hermes/lệnh tuỳ chỉnh, hoặc bị cắt) ⇒ mọi trường null.
 */
export function parseRunOutput(out) {
  const j = findResultJson(out);
  const empty = { session_id: null, models: [], tokens: null, cost_usd: null, is_error: null, terminal_reason: null, error_code: null, num_turns: null, duration_ms: null };
  if (!j) return empty;
  const mu = j.modelUsage && typeof j.modelUsage === 'object' ? j.modelUsage : {};
  const models = Object.entries(mu).map(([model, u]) => ({ model, input: num(u?.inputTokens), output: num(u?.outputTokens), cache_read: num(u?.cacheReadInputTokens), cache_write: num(u?.cacheCreationInputTokens), cost_usd: num(u?.costUSD) }));
  const tokens = models.length ? { input: sumKnown(models.map((m) => m.input)), cache_read: sumKnown(models.map((m) => m.cache_read)), cache_write: sumKnown(models.map((m) => m.cache_write)), output: sumKnown(models.map((m) => m.output)) } : null;
  return {
    session_id: typeof j.session_id === 'string' ? j.session_id : null, models, tokens,
    cost_usd: models.length ? sumKnown(models.map((m) => m.cost_usd)) : null,
    is_error: typeof j.is_error === 'boolean' ? j.is_error : null, terminal_reason: typeof j.terminal_reason === 'string' ? j.terminal_reason : null,
    error_code: typeof j.api_error_code === 'string' ? j.api_error_code : null, num_turns: num(j.num_turns), duration_ms: num(j.duration_ms),
  };
}

/** Tài khoản THỰC của CLI trên máy này (email trong ~/.claude.json, hoặc $CLAUDE_CONFIG_DIR/.claude.json). Không đọc được ⇒ null. */
export function readAccount(env = process.env) {
  const files = [env.CLAUDE_CONFIG_DIR && join(env.CLAUDE_CONFIG_DIR, '.claude.json'), join(homedir(), '.claude.json')].filter(Boolean);
  for (const f of files) { try { const j = JSON.parse(readFileSync(f, 'utf8')); const a = j?.oauthAccount; if (a?.emailAddress) return { email: String(a.emailAddress), plan: a.organizationRateLimitTier ?? a.billingType ?? null }; } catch { /* thử tệp kế */ } }
  return null;
}

/** #1060 (5): tài khoản THẬT đọc lúc spawn bằng `claude auth status --json` (theo CLAUDE_CONFIG_DIR của tiến trình); lỗi/không có CLI ⇒ rơi về tệp .claude.json. */
export function readAccountLive(env = process.env, exec = execFileSync) {
  if (env.DBIO_AGENTD_NO_LIVE_AUTH === '1') return readAccount(env); // bộ test kín: không gọi claude thật
  try { const j = JSON.parse(String(exec('claude', ['auth', 'status', '--json'], { env, timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }))); const email = j?.email ?? j?.account?.email ?? null; if (email) return { email: String(email), plan: j?.subscriptionType ?? j?.plan ?? null }; } catch { /* rơi về tệp */ }
  return readAccount(env);
}

/** Run còn sống? (mở + có nhịp trong LOST_MS). */
export function liveness(run, now = Date.now()) {
  if (run.ended_at) return 'ended';
  return now - Number(run.last_beat_at ?? run.started_at) > LOST_MS ? 'lost' : 'running';
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

export function createRunStore({ dir = runsDir(), now = () => Date.now() } = {}) {
  const openFile = join(dir, 'open.json');
  const monthFile = (t) => join(dir, `runs-${new Date(t).toISOString().slice(0, 7)}.jsonl`);
  const readOpen = () => { try { const j = JSON.parse(readFileSync(openFile, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
  const writeOpen = (o) => { try { mkdirSync(dir, { recursive: true }); writeFileSync(`${openFile}.tmp`, JSON.stringify(o)); renameSync(`${openFile}.tmp`, openFile); } catch { /* sổ phụ, không làm chết daemon */ } };
  const snapshot = (r) => { try { mkdirSync(dir, { recursive: true }); appendFileSync(monthFile(now()), `${JSON.stringify(r)}\n`); } catch { /* bỏ */ } };
  const attemptNo = (staff, card) => { // lần thử thứ n của (nhân viên, thẻ) trong tháng này
    try { const f = monthFile(now()); if (!existsSync(f)) return 1; const seen = new Set(); for (const l of readFileSync(f, 'utf8').split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (r.staff === staff && r.card === card) seen.add(r.run_id); } catch { /* dòng hỏng */ } } return seen.size + 1; } catch { return 1; }
  };
  let mem = null; // bộ nhớ đệm các run đang mở
  const open = () => (mem ??= readOpen());
  return {
    dir,
    /** Mở run mới. ⇒ bản ghi. */
    start({ staff, card = null, adapter, engine = 'claude', model_requested = null, account = null, machine, wake_kind = 'wake', resumed = null }) {
      const t = now();
      const r = { run_id: randomUUID(), staff, card: CARD_RE.test(String(card ?? '')) ? card : null, adapter, engine, model_requested, models: [], account, machine, wake_kind, resumed, pid: null, session_id: null, attempt: null, lease_gen: 1, lease_until: null, started_at: t, last_beat_at: t, ended_at: null, outcome: null, exit_code: null, error_code: null, tokens: null, cost_usd: null, duration_ms: null, slot_returned_at: null };
      r.attempt = r.card ? attemptNo(staff, r.card) : null;
      open()[r.run_id] = r; writeOpen(open()); snapshot(r); return r;
    },
    update(run_id, patch) { const r = open()[run_id]; if (!r) return null; Object.assign(r, patch); writeOpen(open()); return r; },
    /** Nhịp: ghi last_beat_at (+lease_until nếu có). */
    beat(run_id, leaseMs = 0) { const r = open()[run_id]; if (!r || r.ended_at) return null; r.last_beat_at = now(); if (leaseMs) r.lease_until = r.last_beat_at + leaseMs; writeOpen(open()); return r; },
    /** Kết thúc run: gộp usage đã đo (parseRunOutput) + mã thoát; đóng khỏi open.json, ghi ảnh chụp cuối. */
    end(run_id, { outcome, exit_code = null, usage = null, error_code = null, detail = null }) {
      const r = open()[run_id]; if (!r) return null;
      const t = now(); Object.assign(r, { ended_at: t, last_beat_at: t, outcome, exit_code, error_code: error_code ?? usage?.error_code ?? null, detail: detail ? String(detail).slice(0, 300) : (r.detail ?? null), duration_ms: t - r.started_at });
      if (usage) { r.tokens = usage.tokens ?? null; r.cost_usd = usage.cost_usd ?? null; r.models = usage.models ?? []; r.session_id = usage.session_id ?? r.session_id; }
      delete open()[run_id]; writeOpen(open()); snapshot(r); return r;
    },
    openRuns() { return Object.values(open()); },
    get(run_id) { return open()[run_id] ?? null; },
    /** Đọc sổ tháng (mặc định tháng hiện tại): ảnh chụp cuối của từng run, mới nhất trước. */
    list({ month = new Date(now()).toISOString().slice(0, 7), staff = null, limit = 200 } = {}) {
      const f = join(dir, `runs-${month}.jsonl`); if (!existsSync(f)) return [];
      const by = new Map(); for (const l of readFileSync(f, 'utf8').split('\n')) { if (!l) continue; try { const r = JSON.parse(l); by.set(r.run_id, r); } catch { /* dòng hỏng */ } }
      const open_ = open(); for (const [k, v] of Object.entries(open_)) by.set(k, v);
      return [...by.values()].filter((r) => !staff || r.staff === staff).sort((a, b) => b.started_at - a.started_at).slice(0, limit);
    },
    months() { try { return readdirSync(dir).filter((x) => /^runs-\d{4}-\d{2}\.jsonl$/.test(x)).map((x) => x.slice(5, 12)).sort(); } catch { return []; } },
  };
}

/** Tóm tắt cho dash/status: tỉ lệ run có usage thật (đạt ≥95%), tổng token, theo model thực. Run lỗi trước khi gọi model KHÔNG tính vào mẫu số. */
export function summarize(runs) {
  const ended = runs.filter((r) => r.ended_at);
  const measurable = ended.filter((r) => !['lost', 'spawn_failed'].includes(r.outcome) && r.error_code !== 'claude_code_version_too_old');
  const withUsage = measurable.filter((r) => r.tokens);
  const tot = { input: null, cache_read: null, cache_write: null, output: null };
  for (const r of withUsage) for (const k of Object.keys(tot)) if (r.tokens[k] != null) tot[k] = (tot[k] ?? 0) + r.tokens[k];
  const byModel = {};
  for (const r of withUsage) for (const m of r.models ?? []) byModel[m.model] = (byModel[m.model] ?? 0) + 1;
  return { runs: runs.length, running: runs.length - ended.length, ended: ended.length, measurable: measurable.length, with_usage: withUsage.length, usage_pct: measurable.length ? Math.round((withUsage.length / measurable.length) * 1000) / 10 : null, tokens: withUsage.length ? tot : null, by_model: byModel };
}
