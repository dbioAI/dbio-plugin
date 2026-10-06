#!/usr/bin/env node
/**
 * scripts/pack.mjs — đóng gói dbio-plugin thành MỘT tệp để máy mới tải bằng link ký của dbio MCP (không qua GitHub).
 *   node scripts/pack.mjs [--out <thư mục>]   ⇒ dbio-plugin-<phiên bản>.tgz + .sha256 + manifest in ra (version, size, sha256, danh sách tệp)
 * Chỉ gói thứ máy khách cần (bin, lib, skills, .claude-plugin, README, package.json); KHÔNG gói test/scripts/.git. Cần lệnh `tar` (Windows 10+, macOS, Linux đều có).
 * Trước khi đăng: kiểm tra chuỗi nội bộ (scripts/check-clean.mjs) — pack từ chối nếu thấy.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['bin', 'lib', 'skills', '.claude-plugin', 'README.md', 'package.json'];
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const OUT = arg('--out') ?? join(ROOT, 'dist');

/**
 * Mẫu cấm CHUNG trong gói công khai: khoá/token, đường dẫn máy. Danh sách id/tên NỘI BỘ KHÔNG nằm trong repo này (repo có thể public):
 * đặt ở tệp riêng, mỗi dòng một biểu thức chính quy (dòng trống / bắt đầu # bị bỏ) — truyền bằng --deny <tệp> hoặc biến DBIO_PACK_DENY
 * (máy dev: dbio-internal/config/pack-deny.txt).
 */
export const FORBIDDEN = [/sk_[A-Za-z0-9]{12,}/, /Bearer [A-Za-z0-9._-]{16,}/, /[A-Za-z]:[\\/]+(Users|2026)\b/, /\/Users\/[a-z][\w.-]*\//];

export function loadDeny(file) {
  if (!file) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => new RegExp(l, 'u'));
}

function walk(p, acc = []) {
  if (!existsSync(p)) return acc;
  if (statSync(p).isDirectory()) { for (const f of readdirSync(p)) walk(join(p, f), acc); } else acc.push(p);
  return acc;
}

const files = INCLUDE.flatMap((i) => walk(join(ROOT, i))).map((f) => relative(ROOT, f).split('\\').join('/')).sort();
const bad = [];
const DENY = [...FORBIDDEN, ...loadDeny(arg('--deny') ?? process.env.DBIO_PACK_DENY)];
if (!arg('--deny') && !process.env.DBIO_PACK_DENY) console.error('⚠ chưa có danh sách cấm nội bộ (--deny <tệp> / DBIO_PACK_DENY) — chỉ quét mẫu chung; trước khi đăng/push hãy quét lại với danh sách nội bộ.');
for (const f of files) { const t = readFileSync(join(ROOT, f), 'utf8'); for (const re of DENY) if (re.test(t)) bad.push(`${f}: ${re.source.length > 12 ? re.source.slice(0, 4) + '…' : re.source}`); } // không in nguyên mẫu nội bộ
if (bad.length) { console.error(`Từ chối đóng gói — còn chuỗi nội bộ/bí mật:\n${bad.join('\n')}`); process.exit(1); }

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
mkdirSync(OUT, { recursive: true });
const tgz = join(OUT, `dbio-plugin-${version}.tgz`);
execFileSync('tar', ['-czf', `dbio-plugin-${version}.tgz`, '-C', ROOT, ...files], { stdio: 'inherit', cwd: OUT }); // cwd=OUT + tên tương đối: tar GNU coi 'C:' là máy từ xa
const sha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex');
writeFileSync(`${tgz}.sha256`, `${sha256}  dbio-plugin-${version}.tgz\n`);
console.log(JSON.stringify({ version, file: tgz, size: statSync(tgz).size, sha256, files: files.length }, null, 2));
