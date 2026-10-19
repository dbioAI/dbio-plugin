// #1113: chặn báo xong khi mã chưa lên origin — kiểm bằng MÃ (không trông vào việc model nhớ luật).
import { git } from './common.mjs';

const SHA_RE = /\b[0-9a-f]{7,40}\b/gi;

/** sha (≥7 hex, có chữ cái VÀ chữ số) nhắc trong các chuỗi; bỏ số thuần / từ thường. */
export function shasIn(...texts) {
  const out = new Set();
  for (const t of texts) for (const m of String(t ?? '').match(SHA_RE) ?? []) if (/[a-f]/i.test(m) && /\d/.test(m)) out.add(m.toLowerCase());
  return [...out];
}

/**
 * Báo cáo mã chưa push của kho `top`:
 *  - ahead: dòng `sha subject` của `@{u}..HEAD` (commit chưa lên upstream; không có upstream ⇒ rỗng)
 *  - shas : sha nhắc trong `texts` có thật trong kho cục bộ nhưng KHÔNG nằm trên nhánh remote nào
 * Sha không có trong kho ⇒ bỏ qua (có thể ở kho khác).
 */
export function unpushedReport(top, texts = []) {
  if (!top) return { ahead: [], shas: [], any: false };
  const ahead = git(top, 'log', '--format=%h %s', '@{u}..HEAD').split('\n').map((s) => s.trim()).filter(Boolean);
  const shas = shasIn(...texts).filter((s) => git(top, 'cat-file', '-t', `${s}^{commit}`) === 'commit' && !git(top, 'branch', '-r', '--contains', s).trim());
  return { ahead, shas, any: ahead.length > 0 || shas.length > 0 };
}

export const describeUnpushed = (r) => [r.ahead.length ? `${r.ahead.length} commit chưa lên upstream (${r.ahead.slice(0, 3).join(' | ')})` : '', r.shas.length ? `sha chưa nằm trên nhánh remote nào: ${r.shas.join(', ')}` : ''].filter(Boolean).join('; ');
