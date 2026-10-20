// #1113 (6): báo xong thẻ có mã client-frontend / dash / worker mà chưa nói đến bản chạy thật ⇒ TỪ CHỐI (kiểm khai báo, không gọi mạng:
// version.json của client không tin được — docs §27bp-e). Có bằng chứng deploy trong --state/--proof, hoặc --not-deployed "<lý do>" (ghi lên thẻ).
import { git } from './common.mjs';
import { shasIn } from './push-guard.mjs';

/** Đường dẫn (tương đối gốc kho) thuộc mã phải DEPLOY mới tới người dùng. */
const DEPLOYABLE = [/^client-frontend\//, /^(?:admin-frontend|dash|dash-frontend)\//, /^backend\/(?:src|workers?)\//, /^workers?\//, /^[^/]+\/wrangler\.toml$/];
export const deployableFiles = (files) => (files ?? []).filter((f) => DEPLOYABLE.some((re) => re.test(String(f).replaceAll('\\', '/'))));

/** Văn bản đã nêu bằng chứng bản chạy thật (deploy / live / số bản 0.0.x / version.json). */
export const claimsDeployed = (...texts) => /\b(?:đã\s+deploy|deploy(?:ed)?|deploy\s+(?:ok|xong|thành\s*công)|live|version\.json|promote(?:d)?|staging)\b|\b\d+\.\d+\.\d{3,}\b/i.test(texts.map((t) => String(t ?? '')).join('\n'));

/** File đổi bởi HEAD + các sha nhắc trong texts (sha có thật trong kho). ⇒ {files, deployable} */
export function changedDeployables(top, texts = []) {
  if (!top) return { files: [], deployable: [] };
  const shas = ['HEAD', ...shasIn(...texts).filter((s) => git(top, 'cat-file', '-t', `${s}^{commit}`) === 'commit')];
  const files = new Set();
  for (const s of shas) for (const f of git(top, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', s).split('\n').map((x) => x.trim()).filter(Boolean)) files.add(f);
  return { files: [...files], deployable: deployableFiles([...files]) };
}
