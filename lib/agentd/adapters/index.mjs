/**
 * lib/agentd/adapters/index.mjs — SỔ ĐĂNG KÝ adapter. Có sẵn: claude-cli · claude-desktop · codex · hermes · command. Cắm thêm: registerAdapter({name, wake(ctx)})
 * hoặc khai `adapter_modules` trong cấu hình (mỗi tệp .mjs export default {name, wake}). wake(ctx) ⇒ {ok, detail, running?: Promise}; ctx = {staff, entry, prompt, events, timeoutS, env, …}.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import claudeCli from './claude-cli.mjs';
import claudeDesktop from './claude-desktop.mjs';
import codex from './codex.mjs';
import command from './command.mjs';
import hermes from './hermes.mjs';

const registry = new Map();
export function registerAdapter(a) {
  if (!a || typeof a.name !== 'string' || typeof a.wake !== 'function') throw new Error('adapter phải có {name: chuỗi, wake: hàm}');
  registry.set(a.name, a);
}
for (const a of [claudeCli, claudeDesktop, codex, hermes, command]) registerAdapter(a);

export const getAdapter = (name) => registry.get(name) ?? null;
export const adapterNames = () => [...registry.keys()];

export async function loadAdapterModules(files, base = process.cwd()) {
  const errors = [];
  for (const f of files ?? []) {
    try { const m = await import(pathToFileURL(resolve(base, f)).href); registerAdapter(m.default); } catch (e) { errors.push(`${f}: ${e.message}`); }
  }
  return errors;
}
