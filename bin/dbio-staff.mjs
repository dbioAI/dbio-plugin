#!/usr/bin/env node
/**
 * dbio-staff — MỘT lệnh vào của dbio-plugin:  dbio-staff <nhóm> <lệnh> [...]
 *
 *   staff     làm việc với sổ cái: whoami · card · checkpoint · say · move · new · inbox · ack · reply · status · stuck · assign · done · watch · next · sweep · call …
 *   playbook  get · log · propose — đọc / góp ý AI Playbook ONLINE của vai (qua MCP, bằng khoá nhân viên)
 *
 * Khoá: ~/.dbio/staff-keys/<tên>.json (do quản trị workspace cấp). Tên: --as "<tên>" hoặc biến DBIO_STAFF.
 * Sổ cái: --board · DBIO_BOARD · trường "board" của khoá · thẻ đang cầm (máy chủ). Không đoán.
 * Mã thoát: 0 ok · 1 lỗi · 2 khoá/danh tính · 3 cần người.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, helpOf } from '../lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GROUPS = ['staff', 'playbook'];
const [group, ...rest] = process.argv.slice(2);
if (!group || ['--help', '-h', 'help'].includes(group)) die(helpOf(import.meta.url), 0);
if (!GROUPS.includes(group)) die(`Nhóm lạ "${group}". Có: ${GROUPS.join(' · ')}`);
const file = join(here, 'cmd', `${group}.mjs`);
if (!existsSync(file)) die(`Thiếu ${file}`, 1);
const r = spawnSync(process.execPath, [file, ...rest], { stdio: 'inherit' });
process.exit(r.status ?? 1);
