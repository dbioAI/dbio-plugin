#!/usr/bin/env node
/**
 * dbio-turn-guard — hook PostToolUse của Claude Code cho lượt ngầm agentd (#1062): lượt > 30 phút / > 1M cache-đọc ⇒ nhắc checkpoint ở điểm an toàn (một lần mỗi bậc).
 * stdin = JSON hook; stdout = JSON hookSpecificOutput.additionalContext khi cần nhắc; không bao giờ làm hỏng lượt (lỗi ⇒ im, mã 0).
 */
import { guardOnce } from '../lib/agentd/turn-guard.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; if (raw.length > 1_000_000) raw = raw.slice(0, 1_000_000); });
process.stdin.on('end', () => {
  try { const { output } = guardOnce(JSON.parse(raw || '{}')); if (output) process.stdout.write(output); } catch { /* im */ }
  process.exit(0);
});
