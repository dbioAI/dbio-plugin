/**
 * lib/agentd/runlog.mjs — NHẬT KÝ LƯỢT (#1076): luồng `claude -p --output-format stream-json --verbose` ⇒ "bước" có nghĩa ⇒ đẩy lô 60s lên máy chủ (task_board run_event).
 * Bước = {run_id, at, kind: cmd|edit|test|build|deploy|mcp|wait|note, text}. text ≤ 80 ký tự, đã bỏ giá trị khoá; KHÔNG bao giờ chứa nội dung tệp / kết quả công cụ.
 * Cờ tắt (privacy): entry.run_events === false | defaults.run_events === false | DBIO_AGENTD_RUN_EVENTS=0. Trần mặc định 500 bước / lượt.
 */
export const MAX_TEXT = 80;
export const MAX_EVENTS = 500;
export const FLUSH_MS = 60_000;
export const KINDS = ['cmd', 'edit', 'test', 'build', 'deploy', 'mcp', 'wait', 'note'];

/** Che giá trị giống khoá/token trong một chuỗi (chạy TRƯỚC khi cắt ngắn để không lòi nửa khoá). */
export function redact(s) {
  return String(s ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, '***')
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[a-z]|AKIA|AIza|ya29|eyJ)[-_A-Za-z0-9.]{8,}/g, '***')
    .replace(/\b(Bearer|Basic)\s+[-_A-Za-z0-9.=+/]{8,}/gi, '$1 ***')
    .replace(/((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|authorization|auth|key|cookie)\w*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(--(?:api[_-]?key|secret|token|password|key|auth)\w*[ =])\S+/gi, '$1***')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '***')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '***');
}
const clip = (s, n = MAX_TEXT) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** Đường dẫn: giữ ĐUÔI (tên tệp quan trọng hơn gốc). */
const clipPath = (p, n = MAX_TEXT - 5) => { const t = String(p ?? '').replace(/\\/g, '/'); return t.length > n ? `…${t.slice(-(n - 1))}` : t; };

const RE = {
  deploy: /\b(wrangler\s+(?:pages\s+)?deploy|deploy[-\w]*\.(?:sh|mjs|cjs|cmd|ps1)|npm\s+run\s+deploy\b|pm2\s+(?:reload|restart)\b)/i,
  test: /\b(node\s+--test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|vitest|jest|pytest|playwright\s+test|go\s+test|cargo\s+test)\b|\.test\.m?[jt]s\b/i,
  build: /\b((?:npm|pnpm|yarn)\s+run\s+build\S*|ng\s+build|vite\s+build|tsc(?:\s|$)|webpack|esbuild|next\s+build)/i,
  wait: /^\s*(?:sleep\b|start-sleep\b|timeout\s+\/t\b)|\buntil\b.*;\s*do\b|\bwhile\b.*;\s*do\b.*\bsleep\b/i,
};
/** Lệnh Bash/PowerShell ⇒ {kind, text}. Chỉ dòng ĐẦU của lệnh (heredoc/nội dung tệp không lọt). */
export function classifyCommand(cmd) {
  const first = String(cmd ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  const kind = RE.wait.test(first) ? 'wait' : RE.deploy.test(first) ? 'deploy' : RE.test.test(first) ? 'test' : RE.build.test(first) ? 'build' : 'cmd';
  return { kind, text: clip(redact(first)) };
}

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'ToolSearch', 'WebSearch', 'WebFetch', 'TaskOutput', 'ScheduleWakeup']);
/** tool_use ⇒ bước | null (công cụ chỉ-đọc là nhiễu, bỏ). */
export function stepFromToolUse(tu) {
  const name = String(tu?.name ?? ''); const inp = tu?.input && typeof tu.input === 'object' ? tu.input : {};
  if (name === 'Bash' || name === 'PowerShell') { const c = classifyCommand(inp.command); return c.text ? c : null; }
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'MultiEdit') return { kind: 'edit', text: `${name === 'Write' ? 'Write' : 'Edit'} ${clipPath(redact(inp.file_path ?? inp.notebook_path ?? ''))}` };
  if (name.startsWith('mcp__')) {
    const [, server = '', ...rest] = name.split('__'); const tool = rest.join('__');
    const action = typeof inp.action === 'string' ? inp.action : typeof inp.command === 'string' ? inp.command.split(/\s+/)[0] : '';
    const isDeploy = /deploy|publish|release/i.test(`${tool} ${action}`);
    return { kind: isDeploy ? 'deploy' : 'mcp', text: clip(redact(`${server.replace(/^claude_ai_/, '')}.${tool}${action ? ` ${action}` : ''}`)) };
  }
  if (name === 'Task' || name === 'Agent') return { kind: 'note', text: clip(`Sub-agent: ${redact(inp.description ?? '')}`) };
  if (READ_ONLY.has(name)) return null;
  return { kind: 'cmd', text: clip(redact(name)) };
}

/**
 * Bộ rút bước từ từng dòng stream-json. feed(line) ⇒ mảng {kind,text} (có thể rỗng). Dòng không phải JSON/không quan tâm ⇒ bỏ.
 * Ghép tool_result với tool_use để biết test/build pass hay fail ⇒ thêm bước note "test pass|fail".
 * stats(): {cmd, edit, test:{pass,fail}, deploy:[..]} dùng cho dòng tóm tắt cuối lượt.
 */
export function createExtractor() {
  const pending = new Map(); // tool_use_id ⇒ {kind}
  const st = { steps: 0, cmd: 0, edit: new Set(), test: { pass: 0, fail: 0 }, build: { pass: 0, fail: 0 }, deploy: [], mcp: 0 };
  const noteStep = (s, id) => {
    st.steps++;
    if (s.kind === 'edit') st.edit.add(s.text.replace(/^(Edit|Write) /, ''));
    else if (s.kind === 'mcp') st.mcp++;
    else if (s.kind === 'cmd' || s.kind === 'wait') st.cmd++;
    else if (s.kind === 'test' || s.kind === 'build' || s.kind === 'deploy') { st.cmd++; if (id) pending.set(id, { kind: s.kind, text: s.text }); }
  };
  return {
    feed(line) {
      const l = String(line ?? '').trim(); if (!l.startsWith('{')) return [];
      let j; try { j = JSON.parse(l); } catch { return []; }
      const out = [];
      if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
        for (const c of j.message.content) if (c?.type === 'tool_use') { const s = stepFromToolUse(c); if (s) { noteStep(s, c.id); out.push(s); } }
      } else if (j.type === 'user' && Array.isArray(j.message?.content)) {
        for (const c of j.message.content) {
          if (c?.type !== 'tool_result') continue;
          const p = pending.get(c.tool_use_id); if (!p) continue; pending.delete(c.tool_use_id);
          const body = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x?.text ?? '').join(' ') : '';
          const fail = c.is_error === true || (p.kind !== 'deploy' && /\b(?:fail(?:ed|ing)?|error)\b\D{0,12}[1-9]\d*|\b[1-9]\d* (?:fail(?:ed|ing)?|errors?)\b|# fail [1-9]/i.test(body.slice(-2000)));
          if (p.kind === 'test') { st.test[fail ? 'fail' : 'pass']++; out.push({ kind: 'note', text: `test ${fail ? 'FAIL' : 'pass'}` }); }
          else if (p.kind === 'build') { st.build[fail ? 'fail' : 'pass']++; out.push({ kind: 'note', text: `build ${fail ? 'FAIL' : 'ok'}` }); }
          else if (p.kind === 'deploy' && !fail) {
            const v = /\b(?:Version ID|version)[:\s]+([0-9a-f-]{8,36})/i.exec(body) ?? /\b([0-9a-f]{7,12})\b/.exec(p.text);
            const ver = v ? v[1].slice(0, 8) : 'ok'; st.deploy.push(ver); out.push({ kind: 'note', text: `deploy ${ver}` });
          } else if (p.kind === 'deploy') out.push({ kind: 'note', text: 'deploy FAIL' });
        }
      }
      return out;
    },
    stats: () => st,
    /** "12 lệnh · 4 tệp · test 3 pass/1 fail · deploy a1b2c3d4" (chỉ phần có số liệu). */
    summary() {
      const p = [`${st.cmd} lệnh`, `${st.edit.size} tệp sửa`];
      if (st.mcp) p.push(`${st.mcp} gọi MCP`);
      if (st.test.pass + st.test.fail) p.push(`test ${st.test.pass} pass/${st.test.fail} fail`);
      if (st.build.pass + st.build.fail) p.push(`build ${st.build.pass} ok/${st.build.fail} lỗi`);
      if (st.deploy.length) p.push(`deploy ${st.deploy.join(',')}`);
      return p.join(' · ');
    },
  };
}

export const runEventsEnabled = (entry, cfg, env = process.env) => !(entry?.run_events === false || cfg?.defaults?.run_events === false || /^(0|false|off)$/i.test(String(env.DBIO_AGENTD_RUN_EVENTS ?? '')));

/**
 * Nhật ký một lượt: feedLine(line) rút bước, gom lô, mỗi flushMs gọi send(batch ≤100) (best-effort — lỗi ⇒ giữ lô, thử lại nhịp sau, không bao giờ ném).
 * Trần maxEvents bước/lượt. end() ⇒ đẩy nốt (thử lại tối đa endTries lần), trả dòng tóm tắt gồm "đẩy n/nhận n".
 * Mỗi lần đẩy ghi log qua onLog (số lượng + mã lỗi) — không nuốt lỗi im lặng.
 */
export const BATCH_MAX = 100;
export function createRunLog({ runId, send, now = () => Date.now(), flushMs = FLUSH_MS, maxEvents = MAX_EVENTS, setTimer = setInterval, clearTimer = clearInterval, onLog = () => {}, endTries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const ex = createExtractor(); let buf = []; let total = 0; let capped = false; let flushing = null; let stopped = false;
  const net = { sent: 0, accepted: 0, dropped: 0, failed: 0, lastError: null };
  const push = (s) => {
    if (total >= maxEvents) { if (!capped) { capped = true; buf.push({ run_id: runId, seq: total + 1, at: new Date(now()).toISOString(), kind: 'note', text: `đã chạm trần ${maxEvents} sự kiện/lượt — bỏ phần sau` }); } return; }
    total++; buf.push({ run_id: runId, seq: total, at: new Date(now()).toISOString(), kind: KINDS.includes(s.kind) ? s.kind : 'note', text: clip(s.text) });
  };
  const errCode = (e) => String(e?.code ?? e?.status ?? e?.message ?? e ?? 'lỗi').replace(/\s+/g, ' ').slice(0, 120);
  const log = (m) => { try { onLog(m); } catch { /* log phụ */ } };
  let failStreak = 0; // #1094: lỗi mạng liên tiếp ⇒ chỉ 1 dòng log (lần đầu) + 1 dòng phục hồi, không mỗi nhịp
  /** Đẩy hết buf theo lô ≤BATCH_MAX; lô lỗi ⇒ trả lại đầu buf (giữ thứ tự seq), dừng tới nhịp sau. */
  const drain = async () => {
    while (buf.length) {
      const batch = buf.slice(0, BATCH_MAX); buf = buf.slice(batch.length);
      try {
        const r = await send(batch);
        const acc = Number.isFinite(Number(r?.accepted)) ? Number(r.accepted) : batch.length; const drp = Number.isFinite(Number(r?.dropped)) ? Number(r.dropped) : 0;
        net.sent += batch.length; net.accepted += acc; net.dropped += drp; net.lastError = null;
        if (failStreak) { log(`đẩy nhật ký phục hồi sau ${failStreak} nhịp lỗi`); failStreak = 0; }
        log(`đẩy ${batch.length} bước (seq ${batch[0].seq}-${batch[batch.length - 1].seq}) → nhận ${acc}${drp ? `, bỏ ${drp}` : ''}`);
      } catch (e) {
        net.failed += batch.length; net.lastError = errCode(e); buf = [...batch, ...buf].slice(0, maxEvents + 1);
        if (++failStreak === 1) log(`đẩy ${batch.length} bước LỖI ${net.lastError} — giữ lại, thử nhịp sau (còn ${buf.length}); các nhịp lỗi kế không báo lại tới khi phục hồi`);
        return;
      }
    }
  };
  const flush = () => {
    if (flushing) return flushing.then(() => (buf.length ? flush() : undefined));
    if (!buf.length) return Promise.resolve();
    flushing = drain().finally(() => { flushing = null; });
    return flushing;
  };
  const timer = setTimer(() => flush().catch(() => {}), flushMs); timer?.unref?.();
  const netSummary = () => (total ? `đẩy ${net.sent}/${total} · máy chủ nhận ${net.accepted}${net.dropped ? ` (bỏ ${net.dropped})` : ''}${net.sent < total ? ` · CHƯA đẩy ${total - net.sent}${net.lastError ? ` (${net.lastError})` : ''}` : ''}` : '');
  return {
    feedLine(line) { if (stopped) return; for (const s of ex.feed(line)) push(s); },
    flush,
    summary: () => [ex.summary(), netSummary()].filter(Boolean).join(' · '),
    stats: () => ({ ...ex.stats(), net: { ...net } }),
    count: () => total,
    async end() { stopped = true; clearTimer(timer); for (let i = 0; i < endTries; i++) { await flush(); if (!buf.length) break; if (i < endTries - 1) await sleep(2000 * (i + 1)); } return this.summary(); },
  };
}
