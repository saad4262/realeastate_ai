import { instantForLocalTime, localPartsIn } from '../schedules/next-run';
import { isValidTimeZone } from '../time/local-input';
import { WEEKDAYS, type WorkflowAction } from './catalog';

/**
 * A `wait_until` step (ADR 0048), frozen onto the step after it when a run is made: minutes of the
 * day on the agency's clock, the weekdays (0 = Sunday) and the zone. Pure — no clock of its own.
 */
export type SendWindow = { from: number; to: number | null; days: number[]; tz: string };

const minute = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function windowFrom(a: Extract<WorkflowAction, { type: 'wait_until' }>, tz: string): SendWindow {
  return {
    from: minute(a.from),
    to: a.to === undefined ? null : minute(a.to),
    days: (a.days ?? WEEKDAYS).map((d) => WEEKDAYS.indexOf(d)).sort((x, y) => x - y),
    tz,
  };
}

/** A step's stored `window`, or null when it has none (or is not one this code wrote). */
export function readWindow(v: unknown): SendWindow | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Record<string, unknown>;
  const mins = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1440;
  if (!mins(w.from) || !(w.to === null || mins(w.to)) || typeof w.tz !== 'string' || !isValidTimeZone(w.tz)) return null;
  if (!Array.isArray(w.days) || !w.days.length || !w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  return { from: w.from as number, to: w.to as number | null, days: w.days as number[], tz: w.tz };
}

/**
 * The first instant at or after `t` the window allows. With `to`: `t` itself when inside a window,
 * else the next window's start. Without: the next `from` on an allowed day (`t` itself if exactly then).
 * Each day's instants come from its own offset, so a DST change moves nothing on the wall clock.
 */
export function nextInWindow(t: Date, w: SendWindow): Date {
  const p = localPartsIn(t, w.tz);
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    if (!w.days.includes(day.getUTCDay())) continue;
    const date = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() };
    const start = instantForLocalTime(date, w.from, w.tz);
    if (w.to === null) {
      if (start.getTime() >= t.getTime()) return start;
      continue;
    }
    if (t.getTime() < start.getTime()) return start;
    if (t.getTime() < instantForLocalTime(date, w.to, w.tz).getTime()) return t;
  }
  return t;
}
