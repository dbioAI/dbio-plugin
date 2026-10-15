/**
 * lib/agentd/accounts.mjs — chọn TÀI KHOẢN Claude cho mỗi lượt (#1060 mục 5/5b, chủ chốt 15/10).
 * Mỗi tài khoản Max = một bản cài CLI với CLAUDE_CONFIG_DIR riêng: cfg.accounts = [{label, config_dir, priority?, reserved_for_owner?}].
 * Luật: bỏ tài khoản đang bị hoãn (retry_at chưa tới / auth) → ưu tiên tài khoản KHÔNG reserved_for_owner (Max 1 của chủ chỉ dùng khi tất cả còn lại hoãn)
 * → trong cùng nhóm lấy priority cao nhất → cùng priority thì LUÂN PHIÊN (ít dùng gần đây nhất). Hàm thuần.
 */
export function normalizeAccounts(list) {
  const out = []; const seen = new Set();
  for (const a of Array.isArray(list) ? list : []) {
    const label = String(a?.label ?? '').trim(); const dir = String(a?.config_dir ?? '').trim();
    if (!label || !dir || seen.has(label)) continue; seen.add(label);
    out.push({ label, config_dir: dir, priority: Number.isFinite(Number(a.priority)) ? Number(a.priority) : 0, reserved_for_owner: !!a.reserved_for_owner });
  }
  return out;
}

/** state[label] = {reason, retry_at(ISO)|null, last_used_at(ms)}. ⇒ {account} | {hold: "<lý do>"} */
export function pickAccount(accounts, state = {}, now = Date.now()) {
  if (!accounts.length) return { account: null };
  const blocked = (a) => { const s = state[a.label]; if (!s?.reason) return null; if (s.reason === 'auth') return 'cần đăng nhập lại'; return s.retry_at && Date.parse(s.retry_at) > now ? `${s.reason === 'quota' ? 'hết quota' : 'rate-limit'} tới ${s.retry_at}` : null; };
  const ok = accounts.filter((a) => !blocked(a));
  if (!ok.length) return { hold: accounts.map((a) => `${a.label}: ${blocked(a)}`).join('; ') };
  const pool = ok.some((a) => !a.reserved_for_owner) ? ok.filter((a) => !a.reserved_for_owner) : ok;
  const top = Math.max(...pool.map((a) => a.priority));
  const cand = pool.filter((a) => a.priority === top).sort((x, y) => (state[x.label]?.last_used_at ?? 0) - (state[y.label]?.last_used_at ?? 0));
  return { account: cand[0] };
}
