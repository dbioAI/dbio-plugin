/**
 * lib/agentd/cli-version.mjs — kiểm phiên bản Claude CLI ↔ model TRƯỚC khi spawn (#1036): CLI quá cũ so với model ⇒ API Error 400 lặng lẽ.
 * Bảng tối thiểu dưới đây là điều đã đo được; thêm dòng khi gặp model mới (hoặc khai defaults.cli_min_versions { "<mẫu regex>": "x.y.z" }).
 */
import { spawnSync } from 'node:child_process';
import { resolveBin } from './adapters/util.mjs';

export const MODEL_MIN_CLI = Object.freeze([{ re: /opus-5-5/, min: '2.1.280' }]);

export function cmpVer(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0); const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/** Phiên bản tối thiểu cho model (chuỗi) hoặc null. extra = { "<regex>": "x.y.z" }. */
export function minCliFor(model, extra = {}) {
  const m = String(model ?? ''); let best = null;
  const rules = [...MODEL_MIN_CLI, ...Object.entries(extra ?? {}).flatMap(([k, v]) => { try { return [{ re: new RegExp(k), min: String(v) }]; } catch { return []; } })];
  for (const r of rules) if (r.re.test(m) && (!best || cmpVer(r.min, best) > 0)) best = r.min;
  return best;
}

const cache = new Map(); // bin → {at, v}
/** `claude --version` → "2.1.296" | null (cache 10 phút). */
export function cliVersion(bin = 'claude', { run = spawnSync, now = Date.now } = {}) {
  const hit = cache.get(bin); if (hit && now() - hit.at < 600_000) return hit.v;
  let v = null;
  try {
    const exe = resolveBin(bin); const win = process.platform === 'win32' && !/\.exe$/i.test(exe);
    const r = run(win && /\s/.test(exe) ? `"${exe}"` : exe, ['--version'], { encoding: 'utf8', timeout: 15_000, shell: win, windowsHide: true });
    v = /(\d+\.\d+\.\d+)/.exec(String(r?.stdout ?? ''))?.[1] ?? null;
  } catch { /* không đọc được ⇒ null (không chặn) */ }
  cache.set(bin, { at: now(), v }); return v;
}

/** ⇒ { ok:true } | { ok:false, version, need, detail }. Không biết phiên bản ⇒ ok (không chặn oan). */
export function checkCliModel({ model, bin = 'claude', extra, getVersion = cliVersion }) {
  const need = minCliFor(model, extra); if (!need) return { ok: true };
  const version = getVersion(bin); if (!version) return { ok: true };
  if (cmpVer(version, need) >= 0) return { ok: true, version, need };
  return { ok: false, version, need, detail: `Claude CLI ${version} quá cũ cho model ${model} (cần ≥ ${need}) — cập nhật: npm i -g @anthropic-ai/claude-code` };
}
