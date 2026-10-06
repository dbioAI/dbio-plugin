#!/usr/bin/env node
/**
 * dbio-staff — MỘT lệnh vào của dbio-plugin:  dbio-staff <nhóm> <lệnh> [...]
 *
 *   staff     làm việc với sổ cái: whoami · card · checkpoint · say · move · new · inbox · ack · reply · status · stuck · assign · done · watch · next · sweep · call …
 *   login · install-skills · bootstrap   dựng máy mới chỉ từ connector dbio MCP (mã thiết bị, tự ghi skill, checkin) — xem `dbio-staff login --help`
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
const SETUP = ['login', 'install-skills', 'bootstrap']; // dựng máy mới: chạy bin/cmd/setup.mjs với tên lệnh
const [group, ...rest] = process.argv.slice(2);
if (!group || ['--help', '-h', 'help'].includes(group)) die(helpOf(import.meta.url), 0);
if (SETUP.includes(group)) { const r0 = spawnSync(process.execPath, [join(here, 'cmd', 'setup.mjs'), group, ...rest], { stdio: 'inherit' }); process.exit(r0.status ?? 1); }
if (!GROUPS.includes(group)) die(`Nhóm lạ "${group}". Có: ${GROUPS.join(' · ')}`);
const file = join(here, 'cmd', `${group}.mjs`);
if (!existsSync(file)) die(`Thiếu ${file}`, 1);
const r = spawnSync(process.execPath, [file, ...rest], { stdio: 'inherit' });
process.exit(r.status ?? 1);
