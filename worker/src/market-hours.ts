/**
 * US equities regular-session market hours (America/New_York).
 *
 * Ported from loader/src/scheduler.ts so bot schedules can gate on the same
 * calendar without depending on the loader Worker. Behavior matches:
 * weekends, exchange holidays, early closes (13:00 ET), and configurable
 * open/close minutes.
 */

const MIN = 60_000;
const HOUR = 3_600_000;

export interface MarketHoursEnv {
  MARKET_HOURS_ENABLED?: string;
  MARKET_OPEN_MINUTES?: string;
  MARKET_CLOSE_MINUTES?: string;
  MARKET_EARLY_CLOSE_MINUTES?: string;
}

export interface MarketState {
  open: boolean;
  reason: string;
  now_minutes: number;
  weekday: number;
  now_et: string;
  next_open: number | null;
}

function num(env: MarketHoursEnv | undefined, key: keyof MarketHoursEnv, dflt: number): number {
  const raw = env?.[key];
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function nthWeekdayDayOfMonth(year: number, month0: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

function lastWeekdayDayOfMonth(year: number, month0: number, weekday: number): number {
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month0, days)).getUTCDay();
  const offset = (last - weekday + 7) % 7;
  return days - offset;
}

function easterUtcMs(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month0 = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month0, day);
}

function isUsDst(utcMs: number): boolean {
  const y = new Date(utcMs).getUTCFullYear();
  const start = Date.UTC(y, 2, nthWeekdayDayOfMonth(y, 2, 0, 2), 7);
  const end = Date.UTC(y, 10, nthWeekdayDayOfMonth(y, 10, 0, 1), 6);
  return utcMs >= start && utcMs < end;
}

function etOffsetHours(utcMs: number): number {
  return isUsDst(utcMs) ? 4 : 5;
}

/** ET wall-clock view of utcMs as a synthetic UTC Date (fields read as New York). */
export function etWall(utcMs: number): Date {
  return new Date(utcMs - etOffsetHours(utcMs) * HOUR);
}

function isHolidayClosed(w: Date): boolean {
  const y = w.getUTCFullYear();
  const mo = w.getUTCMonth();
  const d = w.getUTCDate();
  const on = (m0: number, day: number) => mo === m0 && d === day;
  const observed = (m0: number, day: number) => {
    const dy = new Date(Date.UTC(y, m0, day)).getUTCDay();
    if (dy === 0) return on(m0, day + 1);
    if (dy === 6) return on(m0, day - 1);
    return on(m0, day);
  };
  const gf = new Date(easterUtcMs(y) - 2 * 86_400_000);
  return (
    observed(0, 1)
    || on(0, nthWeekdayDayOfMonth(y, 0, 1, 3))
    || on(1, nthWeekdayDayOfMonth(y, 1, 1, 3))
    || on(gf.getUTCMonth(), gf.getUTCDate())
    || on(4, lastWeekdayDayOfMonth(y, 4, 1))
    || observed(5, 19)
    || observed(6, 4)
    || on(8, nthWeekdayDayOfMonth(y, 8, 1, 1))
    || on(10, nthWeekdayDayOfMonth(y, 10, 4, 4))
    || observed(11, 25)
  );
}

function isEarlyClose(w: Date): boolean {
  const y = w.getUTCFullYear();
  const bf = new Date(Date.UTC(y, 10, nthWeekdayDayOfMonth(y, 10, 4, 4) + 1));
  return (
    (w.getUTCMonth() === 11 && w.getUTCDate() === 24)
    || (w.getUTCMonth() === bf.getUTCMonth() && w.getUTCDate() === bf.getUTCDate())
  );
}

export function marketHoursEnabled(env: MarketHoursEnv | undefined): boolean {
  return (env && env.MARKET_HOURS_ENABLED) !== "false";
}

export function nextOpenMs(nowMs: number, env?: MarketHoursEnv): number {
  const openMin = Math.floor(num(env, "MARKET_OPEN_MINUTES", 9 * 60 + 30));
  const w = etWall(nowMs);
  let y = w.getUTCFullYear();
  let mo = w.getUTCMonth();
  let d = w.getUTCDate();
  for (let i = 0; i < 16; i++) {
    const dow = new Date(Date.UTC(y, mo, d)).getUTCDay();
    const isTrading = dow !== 0 && dow !== 6 && !isHolidayClosed(new Date(Date.UTC(y, mo, d)));
    if (isTrading) {
      const dayUtc = Date.UTC(y, mo, d);
      const offH = etOffsetHours(dayUtc + openMin * MIN);
      const openMs = dayUtc + openMin * MIN + offH * HOUR;
      if (openMs > nowMs) return openMs;
    }
    const nd = new Date(Date.UTC(y, mo, d + 1));
    y = nd.getUTCFullYear();
    mo = nd.getUTCMonth();
    d = nd.getUTCDate();
  }
  return nowMs + 24 * HOUR;
}

export function marketState(nowMs: number, env?: MarketHoursEnv): MarketState {
  const openMin = Math.floor(num(env, "MARKET_OPEN_MINUTES", 9 * 60 + 30));
  const closeMin = Math.floor(num(env, "MARKET_CLOSE_MINUTES", 16 * 60));
  const earlyMin = Math.floor(num(env, "MARKET_EARLY_CLOSE_MINUTES", 13 * 60));
  const w = etWall(nowMs);
  const weekday = w.getUTCDay();
  const minutes = w.getUTCHours() * 60 + w.getUTCMinutes();
  const base = { now_minutes: minutes, weekday, now_et: w.toISOString() };
  if (weekday === 0 || weekday === 6) {
    return { open: false, reason: "weekend", ...base, next_open: nextOpenMs(nowMs, env) };
  }
  if (isHolidayClosed(w)) {
    return { open: false, reason: "holiday", ...base, next_open: nextOpenMs(nowMs, env) };
  }
  const closeToday = isEarlyClose(w) ? earlyMin : closeMin;
  if (minutes >= openMin && minutes < closeToday) {
    return { open: true, reason: "open", ...base, next_open: null };
  }
  return {
    open: false,
    reason: minutes < openMin ? "overnight" : "after-hours",
    ...base,
    next_open: nextOpenMs(nowMs, env),
  };
}

/**
 * Next wake for an hourly (or cadence) market-gated schedule.
 * While open: now + cadence. While closed: next open + 30m (first overview
 * after the open auction settles), capped by cadence.
 */
export function nextScheduleWakeMs(
  nowMs: number,
  cadenceSeconds: number,
  opts?: { marketGated?: boolean; env?: MarketHoursEnv },
): number {
  const cadenceMs = Math.max(60, cadenceSeconds) * 1000;
  const gated = opts?.marketGated !== false;
  if (!gated || !marketHoursEnabled(opts?.env)) return nowMs + cadenceMs;
  const st = marketState(nowMs, opts?.env);
  if (st.open) return nowMs + cadenceMs;
  const openAt = st.next_open ?? nowMs + cadenceMs;
  return openAt + Math.min(30 * MIN, cadenceMs);
}
