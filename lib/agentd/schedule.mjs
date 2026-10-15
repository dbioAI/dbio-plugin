/**
 * lib/agentd/schedule.mjs — MỘT bộ lịch cron cho mọi việc định kỳ của agentd (#1036, chủ chốt 14/10): y hệt Win/Linux/Mac.
 * Biểu thức 6 trường (giây phút giờ ngày tháng thứ) hoặc 5 trường. Đổi trong agentd.json: "schedule": { "<việc>": "<cron>" | false }.
 * Việc không chồng lượt (protect), lỗi trong việc chỉ ghi log — không bao giờ làm daemon thoát.
 */
import { Cron } from 'croner';

/** Mặc định (khớp nhịp cũ). every_min trong cấu hình (discover/sweep/hygiene) vẫn được tôn trọng khi không đặt schedule.<việc>. */
export const DEFAULT_SCHEDULE = {
  status: '*/15 * * * * *',          // ghi tệp trạng thái (nhịp daemon — màn hình/watchdog đọc)
  runs_beat: '*/30 * * * * *',       // nhịp worker: pid ↔ lease
  runs_reconcile: '0 * * * * *',     // đối soát tiến trình ↔ lease ↔ thẻ, mỗi phút
  worker_beat: '*/30 * * * * *',     // #1036 pha D: nhịp MÁY lên máy chủ (ai_workers + tài khoản) — cron máy chủ >5' không nhịp ⇒ Telegram ops
  runs_push: '*/30 * * * * *',       // đẩy Run lên máy chủ / phát lại hàng đợi chưa ack
  reconcile: '0 */5 * * * *',        // mở lại kênh chết, khoá mới
  config_reload: '*/30 * * * * *',   // nạp lại agentd.json khi đổi
  discover: null, sweep: null, hygiene: null, // null = suy từ every_min
};

export const everyMinCron = (min) => {
  const m = Math.floor(Number(min));
  if (!(m >= 1)) return false;
  return m < 60 ? `0 */${m} * * * *` : `0 0 */${Math.max(1, Math.floor(m / 60))} * * *`;
};

/** ⇒ { cron: {việc: biểu thức|false}, errors } — biểu thức hỏng ⇒ báo lỗi, dùng mặc định. */
export function resolveSchedule(cfg) {
  const errors = []; const out = {};
  const every = { discover: cfg?.discover?.every_min, sweep: cfg?.rules?.sweep?.every_min, hygiene: cfg?.rules?.hygiene?.every_min };
  const user = cfg?.schedule && typeof cfg.schedule === 'object' ? cfg.schedule : {};
  for (const [name, def] of Object.entries(DEFAULT_SCHEDULE)) {
    const fallback = def ?? everyMinCron(every[name]);
    const u = user[name];
    if (u === undefined) { out[name] = fallback; continue; }
    if (u === false) { out[name] = false; continue; }
    try { new Cron(String(u), { paused: true }).stop(); out[name] = String(u); } catch (e) { errors.push(`schedule.${name}: biểu thức cron hỏng "${u}" (${e.message}) — dùng mặc định`); out[name] = fallback; }
  }
  for (const k of Object.keys(user)) if (!(k in DEFAULT_SCHEDULE)) errors.push(`schedule.${k}: việc không có trong danh sách (${Object.keys(DEFAULT_SCHEDULE).join(', ')})`);
  return { cron: out, errors };
}

export function createScheduler({ log = () => {} } = {}) {
  const jobs = new Map();
  return {
    /** (Đặt lại) lịch cho `name`: expr falsy ⇒ tắt. fn có thể async. */
    set(name, expr, fn) {
      jobs.get(name)?.stop(); jobs.delete(name);
      if (!expr) return false;
      const j = new Cron(expr, { protect: true, catch: (e) => log(`lịch ${name}: ${e?.message ?? e}`), unref: true }, async () => { await fn(); });
      jobs.set(name, j); return true;
    },
    next: (name) => jobs.get(name)?.nextRun()?.getTime() ?? null,
    names: () => [...jobs.keys()],
    stop() { for (const j of jobs.values()) j.stop(); jobs.clear(); },
  };
}
