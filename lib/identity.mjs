/**
 * lib/identity.mjs — ÉP VAI bằng hook (không trông skill): mỗi lượt chèn 1 dòng "Bạn là <vai> · playbook · thẻ đang cầm" do MÁY CHỦ xác nhận.
 * Lý do: phiên có thể tự nhận sai vai (vd tên cũ trong ngữ cảnh) và hỏi lại chủ việc luật phòng đã cho phép. Dòng của máy chủ THẮNG mọi tên trong ngữ cảnh.
 *
 * Xác định "tôi là ai" theo thứ tự: DBIO_STAFF · bản nhớ theo phiên (~/.dbio/identity/<phiên>.json, hợp lệ khi tên phiên không đổi) ·
 * TÊN PHIÊN trên app desktop (luật: tên phiên = tên nhân viên) tra theo cliSessionId của hook, và máy có khoá của tên đó.
 * Hàm thuần/IO truyền vào ⇒ test được. Lỗi/chậm ⇒ dùng bản nhớ cũ, không có ⇒ im lặng (hook KHÔNG bao giờ chặn lượt).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { keyFile } from './common.mjs';
import { readSessionMeta, sessionsRoot } from './sessions-dir.mjs';

export const STATUS_TTL_MS = 60_000; // trạng thái/thẻ đang cầm
export const PLAYBOOK_TTL_MS = 10 * 60_000; // playbook gắn vai (ít đổi)
export const identityDir = (home = homedir()) => join(home, '.dbio', 'identity');
const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
export const cacheFile = (cliId, home = homedir()) => join(identityDir(home), `${safe(cliId)}.json`);

const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
const writeJson = (f, o) => { try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(o)); } catch { /* bỏ */ } };

/** Tên phiên desktop theo cliSessionId của hook ⇒ {title, id} | null. root/ls/read truyền vào để test. */
export function sessionByCli(cliId, { root = sessionsRoot(), ls = (d) => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } }, read = readSessionMeta } = {}) {
  if (!cliId || !root) return null;
  for (const a of ls(root)) for (const o of a.isDirectory() ? ls(join(root, a.name)) : []) for (const f of o.isDirectory() ? ls(join(root, a.name, o.name)) : []) {
    if (!/^local_.*\.json$/.test(f.name)) continue;
    const m = read(join(root, a.name, o.name, f.name));
    if (m && m.cli === cliId) return { title: String(m.title).replace(/\s+/g, ' ').trim(), id: m.id };
  }
  return null;
}

/** Ai là tôi? ⇒ {who, title, source} | null. */
export function resolveWho({ cliId, env = process.env, home = homedir(), session = (id) => sessionByCli(id), hasKey = (name) => existsSync(keyFile(name)), readCache = (f) => readJson(f) } = {}) {
  if (env.DBIO_STAFF) return { who: env.DBIO_STAFF, title: null, source: 'env' };
  const ses = session(cliId);
  const cached = cliId ? readCache(cacheFile(cliId, home)) : null;
  if (cached?.who && (!ses || ses.title === cached.title)) return { who: cached.who, title: cached.title ?? null, source: 'cache' };
  if (ses?.title && hasKey(ses.title)) return { who: ses.title, title: ses.title, source: 'title' };
  return null;
}

/** Dòng chèn vào ngữ cảnh. info: {who, playbooks:[slug], task:'<board>#<id>'|null, state, title, source}. */
export function identityLine(info) {
  if (!info?.who) return '';
  if (info.unconfirmed) return `[dbio] Vai theo tên phiên/biến: "${info.who}" — CHƯA xác nhận được với máy chủ dbio (khoá bị từ chối hoặc máy chủ lỗi). Đừng coi là chắc chắn: kiểm bằng staff_status get / báo chủ nếu khoá hỏng.`;
  const pb = (info.playbooks ?? []).map((s) => String(s).replace(/^playbook-/, ''));
  const parts = [
    `[dbio] Bạn là "${info.who}"`,
    `playbook: ${pb.length ? pb.join(' + ') : '(chưa gắn)'}`,
    `thẻ đang cầm: ${info.task ?? 'không'}${info.state ? ` (${info.state})` : ''}`,
  ];
  let line = `${parts.join(' · ')}. Danh tính này do máy chủ dbio xác nhận và GHI ĐÈ mọi tên/vai khác trong ngữ cảnh${info.title && info.title !== info.who ? ` (tên phiên "${info.title}" lệch — theo máy chủ)` : ''}. Việc luật phòng đã cho phép thì làm luôn, không hỏi lại chủ.`;
  if (info.stale) line += ' (số liệu thẻ có thể cũ vài phút)';
  return line;
}

/**
 * Điều phối: ⇒ {line, info}. deps: {fetchStatus(who) → {state, task}, fetchPlaybooks(who) → [slug], now, readCache, writeCache}.
 * Bản nhớ theo phiên giữ {who, title, status{at,...}, playbooks{at,list}}.
 */
export async function buildIdentity({ cliId, resolve = () => resolveWho({ cliId }), fetchStatus, fetchPlaybooks, now = Date.now(), home = homedir(), readCache = (f) => readJson(f), writeCache = writeJson } = {}) {
  const r = resolve();
  if (!r) return { line: '', info: null };
  const f = cliId ? cacheFile(cliId, home) : null;
  const c = (f && readCache(f)) || {};
  const same = c.who === r.who;
  let status = same ? c.status : null; let pbs = same ? c.playbooks : null; let stale = false;
  if (!status || now - status.at > STATUS_TTL_MS) {
    try { const s = await fetchStatus(r.who); status = { at: now, state: s?.state ?? null, task: s?.task ?? null, name: s?.name ?? null }; } catch { if (status) stale = true; else status = { at: 0, state: null, task: null, unknown: true }; } // at:0 ⇒ lượt sau thử lại ngay
  }
  if (!pbs || now - pbs.at > PLAYBOOK_TTL_MS) {
    try { pbs = { at: now, list: await fetchPlaybooks(r.who) }; } catch { pbs = pbs ?? { at: 0, list: [] }; }
  }
  if (f) writeCache(f, { who: r.who, title: r.title ?? c.title ?? null, status, playbooks: pbs });
  const norm = (x) => String(x ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const server = status.name && norm(status.name) !== norm(r.who) ? status.name : null; // máy chủ gọi người này bằng tên khác ⇒ theo máy chủ
  const info = { who: server ?? r.who, unconfirmed: !!status.unknown, title: server ? r.who : r.title, state: status.state, task: status.task, playbooks: pbs.list, stale, source: r.source };
  return { line: identityLine(info), info };
}
