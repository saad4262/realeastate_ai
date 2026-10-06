import { instantForLocalTime, localPartsIn } from '../schedules/next-run';

/**
 * Wall-clock time ⇄ instant, for a NAMED zone — never the process's own.
 *
 * The bug this exists to stop (fixed once already, 2026-10-05): a date input
 * filled on the SERVER shows the server's clock. On Vercel that is UTC, so an
 * agent in Melbourne saw a 9 AM appointment as 10 PM the day before, and
 * saving it moved it. Every conversion here takes the zone as an argument;
 * the console passes the browser's (`browserTimeZone()`), and nothing reads
 * `process.env.TZ` or the machine's offset. `local-input.test.ts` runs with the
 * process pinned to UTC to prove it.
 *
 * DST is `instantForLocalTime`'s (schedules/next-run.ts): the autumn hour that
 * happens twice takes the earlier, the spring hour that never happens lands
 * just after the gap.
 *
 * Pure — no database — so client components import it.
 */

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Is this an IANA zone the platform's Intl knows? */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DDTHH:mm` (what a `datetime-local` input holds) in `timeZone`, as an instant. */
export function localInputToInstant(value: string, timeZone: string): Date | null {
  const m = LOCAL_INPUT.exec(value.trim());
  if (!m || !isValidTimeZone(timeZone)) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return instantForLocalTime({ year: y, month: mo, day: d }, h * 60 + mi, timeZone);
}

/** An instant as `YYYY-MM-DDTHH:mm` on the wall clock of `timeZone`. */
export function instantToLocalInput(instant: Date | string, timeZone: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const p = localPartsIn(d, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(Math.floor(p.minuteOfDay / 60))}:${pad(p.minuteOfDay % 60)}`;
}

/** A date input and a time input, joined, as an instant in `timeZone`. */
export function localDateTimeToInstant(date: string, time: string, timeZone: string): Date | null {
  return localInputToInstant(`${date}T${time}`, timeZone);
}

/**
 * "Tue 14 Oct 2026, 9:00 am AEDT" — for text that leaves the platform (an
 * invitation email), where there is no browser to ask: printed in the zone
 * the appointment was booked in, with the zone's name so it cannot be misread.
 */
export function formatInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant);
}

/** The browser's zone. Client-only: on a server this would be the server's — the bug above. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Sydney';
}

/** `YYYY-MM-DD` of `instant` on the wall clock of `timeZone`. */
function localDate(instant: Date, timeZone: string): { y: number; m: number; d: number } {
  const [y, m, d] = instantToLocalInput(instant, timeZone).slice(0, 10).split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

function midnight(y: number, m: number, d: number, timeZone: string): Date {
  // Date.UTC normalises overflow (day 0, month 13…) before we name the calendar day.
  const iso = new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  return localInputToInstant(`${iso}T00:00`, timeZone) as Date;
}

/** Midnight starting the local day `offsetDays` from the one `now` falls on, in `timeZone`. */
export function startOfDayIn(now: Date, timeZone: string, offsetDays = 0): Date {
  const { y, m, d } = localDate(now, timeZone);
  return midnight(y, m, d + offsetDays, timeZone);
}

/** Midnight starting Monday of the local week `now` falls in (Australian weeks start on Monday). */
export function startOfWeekIn(now: Date, timeZone: string, offsetWeeks = 0): Date {
  const { y, m, d } = localDate(now, timeZone);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const back = (weekday + 6) % 7;
  return midnight(y, m, d - back + offsetWeeks * 7, timeZone);
}

/** Midnight starting the local month `offsetMonths` from `now`'s. */
export function startOfMonthIn(now: Date, timeZone: string, offsetMonths = 0): Date {
  const { y, m } = localDate(now, timeZone);
  return midnight(y, m + offsetMonths, 1, timeZone);
}

/** Midnight starting the local year `now` falls in. */
export function startOfYearIn(now: Date, timeZone: string): Date {
  const { y } = localDate(now, timeZone);
  return midnight(y, 1, 1, timeZone);
}
