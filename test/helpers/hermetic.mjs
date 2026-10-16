// #1075 LUẬT CỨNG: bộ test KHÔNG spawn claude thật, không nối kênh thật, không đọc ~/.dbio thật.
// Nhập ĐẦU TIÊN trong mọi tệp test: HOME/USERPROFILE/DBIO_HOME ⇒ thư mục tạm; xoá khoá/URL thật khỏi env;
// PATH có `claude` GIẢ đứng trước (ghi dấu vào MARKER rồi thoát lỗi) ⇒ test nào lỡ gọi claude thật sẽ để lại dấu và bị bắt.
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

if (!process.env.DBIO_TEST_HERMETIC) {
  const real = homedir();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dbio-hermetic-')));
  const home = join(root, 'home'); const bin = join(root, 'bin'); mkdirSync(home, { recursive: true }); mkdirSync(bin, { recursive: true });
  const marker = join(root, 'claude-spawned.txt');
  const sh = `#!/bin/sh\necho "$0 $*" >> "${marker.split('\\').join('/')}"\nexit 97\n`;
  writeFileSync(join(bin, 'claude'), sh); try { chmodSync(join(bin, 'claude'), 0o755); } catch { /* win */ }
  writeFileSync(join(bin, 'claude.cmd'), `@echo %0 %* >> "${marker}"\r\n@exit /b 97\r\n`);
  process.env.DBIO_REAL_HOME = real;
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.DBIO_HOME = home;
  for (const k of Object.keys(process.env)) if (/^(DBIO_(MACHINE_KEY|STAFF_KEY|MCP|TOKEN)|CLAUDE_CONFIG_DIR|ANTHROPIC_)/.test(k)) delete process.env[k];
  process.env.PATH = bin + delimiter + (process.env.PATH ?? '');
  process.env.DBIO_TEST_CLAUDE_MARKER = marker;
  process.env.DBIO_AGENTD_NO_LIVE_AUTH = '1';
  process.env.DBIO_TEST_HERMETIC = '1';
}
if (homedir() === process.env.DBIO_REAL_HOME || process.env.DBIO_HOME === homedir() && !String(process.env.DBIO_HOME).includes('dbio-hermetic-')) throw new Error('hermetic: homedir vẫn là thật');
export const claudeSpawned = () => existsSync(process.env.DBIO_TEST_CLAUDE_MARKER);
// Mọi tệp test chạy tiến trình riêng ⇒ tự kiểm lúc thoát: có dấu `claude` giả ⇒ tệp này đã gọi claude ⇒ THẤT BẠI.
if (!globalThis.__hermeticExit) { globalThis.__hermeticExit = true; process.on('exit', () => { if (existsSync(process.env.DBIO_TEST_CLAUDE_MARKER)) { console.error('HERMETIC: test đã gọi `claude` — cấm (dùng bin giả + DBIO_HOME tạm): ' + readFileSync(process.env.DBIO_TEST_CLAUDE_MARKER, 'utf8').trim().slice(0, 600)); process.exitCode = 1; } }); }
