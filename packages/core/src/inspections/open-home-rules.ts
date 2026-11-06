import { z } from 'zod';
import { instantToLocalInput, localDateTimeToInstant } from '../time/local-input';
import { stateTimeZone } from './plan';

/**
 * Open-home entry's rules (ADR 0081; mock docs/mocks/open-home-entry.html). Pure, no database: the console's form previews
 * with them, the import reads its column with them in the browser, and the server enforces them.
 */

export const OPEN_HOME_KINDS = ['open', 'private', 'auction'] as const;
export type OpenHomeKind = (typeof OPEN_HOME_KINDS)[number];
export const OPEN_HOME_LABEL: Record<OpenHomeKind, string> = { open: 'Open home', private: 'By appointment', auction: 'Auction' };

export const MIN_OPEN_HOME_MINUTES = 10;
export const MAX_OPEN_HOME_MINUTES = 240;
export const MAX_UPCOMING_OPEN_HOMES = 20;
export const MAX_REPEAT_WEEKS = 6;
export const MAX_AHEAD_DAYS = 183;
/** An imported auction has a start only; this is how long it is shown as lasting. */
export const IMPORTED_AUCTION_MINUTES = 60;
const EARLIEST_MINUTE = 7 * 60;
const LATEST_MINUTE = 20 * 60;

const LENGTH_MESSAGE = 'An open home runs between 10 minutes and 4 hours.';

export const openHomeInputSchema = z
  .object({
    kind: z.enum(OPEN_HOME_KINDS),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a day.'),
    start: z.string().regex(/^\d{2}:\d{2}$/, 'Choose a start time.'),
    minutes: z.number().int().min(MIN_OPEN_HOME_MINUTES, LENGTH_MESSAGE).max(MAX_OPEN_HOME_MINUTES, LENGTH_MESSAGE),
    weeks: z.number().int().min(1).max(MAX_REPEAT_WEEKS).default(1),
    confirmedHours: z.boolean().default(false),
  })
  .strict();
export type OpenHomeInput = z.input<typeof openHomeInputSchema>;

export type OpenHomeSlot = { startsAt: Date; endsAt: Date };
export type ExistingOpenHome = OpenHomeSlot & { id: string; kind: OpenHomeKind };
export type SlotCheck = { ok: true } | { ok: false; message: string; confirm?: true };

const PLACE: Record<string, string> = { NSW: 'Sydney', ACT: 'Canberra', VIC: 'Melbourne', TAS: 'Hobart', QLD: 'Brisbane', SA: 'Adelaide', NT: 'Darwin', WA: 'Perth' };

/** The city the property's clock is named after ("Melbourne time"). */
export function statePlace(state: string): string {
  return PLACE[state.toUpperCase()] ?? 'Sydney';
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** One slot per week, each on the property's wall clock, so a repeat keeps its hour across daylight saving. Null: not a real time. */
export function openHomeSlots(input: { date: string; start: string; minutes: number; weeks?: number }, timeZone: string): OpenHomeSlot[] | null {
  const slots: OpenHomeSlot[] = [];
  for (let week = 0; week < (input.weeks ?? 1); week += 1) {
    const startsAt = localDateTimeToInstant(addDays(input.date, week * 7), input.start, timeZone);
    if (!startsAt) return null;
    slots.push({ startsAt, endsAt: new Date(startsAt.getTime() + input.minutes * 60_000) });
  }
  return slots;
}

/** The same wall-clock time a week on (the row's "Next week"). */
export function openHomeNextWeek(row: OpenHomeSlot, timeZone: string): { date: string; start: string; minutes: number } {
  const [date, start] = instantToLocalInput(row.startsAt, timeZone).split('T') as [string, string];
  return { date: addDays(date, 7), start, minutes: Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000) };
}

/** The form's first day: the coming Saturday, or the one after when that is today or tomorrow. */
export function defaultOpenHomeDate(now: Date, timeZone: string): string {
  const today = instantToLocalInput(now, timeZone).slice(0, 10);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const untilSaturday = (6 - new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 7) % 7;
  return addDays(today, untilSaturday <= 1 ? untilSaturday + 7 : untilSaturday);
}

const clean = (s: string) => s.replace(/ /g, ' ').replace(/,/g, '');

/** "Sat 14 Nov 2026" */
export function openHomeDay(at: Date, timeZone: string): string {
  return clean(new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(at));
}

/** "Saturday 14 November", for the public card. */
export function openHomeLongDay(at: Date, timeZone: string): string {
  return clean(new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone }).format(at));
}

/** "10:00 am" */
export function openHomeTime(at: Date, timeZone: string): string {
  return clean(new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(at));
}

/** "10:00 – 10:30 am", or "11:30 am – 12:00 pm" across noon. */
export function openHomeRange(slot: OpenHomeSlot, timeZone: string): string {
  const a = openHomeTime(slot.startsAt, timeZone);
  const b = openHomeTime(slot.endsAt, timeZone);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
}

const minuteOfDay = (at: Date, timeZone: string) => {
  const [h, m] = instantToLocalInput(at, timeZone).slice(11).split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/**
 * May these slots be saved? `existing` is the listing's upcoming times, without the row being edited. All or nothing: the
 * first problem is the answer, naming the week it is in, so a repeat is never half saved.
 */
export function checkOpenHomeSlots(
  slots: readonly OpenHomeSlot[],
  ctx: { kind: OpenHomeKind; existing: readonly ExistingOpenHome[]; now: Date; timeZone: string; place: string; confirmedHours: boolean },
): SlotCheck {
  const { timeZone } = ctx;
  const latest = ctx.now.getTime() + MAX_AHEAD_DAYS * 86_400_000;
  for (const s of slots) {
    if (s.startsAt.getTime() <= ctx.now.getTime()) return { ok: false, message: 'This time has already passed. Choose a time from now on.' };
    if (s.startsAt.getTime() > latest) return { ok: false, message: 'Times can be set up to 6 months ahead.' };
  }
  if (ctx.kind === 'auction') {
    if (slots.length > 1) return { ok: false, message: 'An auction happens once, so it cannot repeat.' };
    const other = ctx.existing.find((e) => e.kind === 'auction');
    if (other) return { ok: false, message: `This listing already has an auction on ${openHomeDay(other.startsAt, timeZone)}. Edit that one instead.` };
  }
  if (ctx.existing.length + slots.length > MAX_UPCOMING_OPEN_HOMES) {
    return { ok: false, message: `A listing can have ${MAX_UPCOMING_OPEN_HOMES} upcoming times. Remove one to add another.` };
  }
  for (const s of slots) {
    const clash = ctx.existing.find((e) => s.startsAt < e.endsAt && e.startsAt < s.endsAt);
    if (clash) {
      return { ok: false, message: `${openHomeDay(s.startsAt, timeZone)} overlaps the ${OPEN_HOME_LABEL[clash.kind].toLowerCase()} at ${openHomeRange(clash, timeZone)} on this listing. Choose another time, or edit that one.` };
    }
  }
  if (!ctx.confirmedHours) {
    for (const s of slots) {
      const from = minuteOfDay(s.startsAt, timeZone);
      const to = from + (s.endsAt.getTime() - s.startsAt.getTime()) / 60_000;
      if (from < EARLIEST_MINUTE || from >= LATEST_MINUTE) return { ok: false, confirm: true, message: `That's ${openHomeTime(s.startsAt, timeZone)} in ${ctx.place}. Is this right?` };
      if (to > LATEST_MINUTE) return { ok: false, confirm: true, message: `That runs until ${openHomeTime(s.endsAt, timeZone)} in ${ctx.place}. Is this right?` };
    }
  }
  return { ok: true };
}

const CELL_PART = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2})$/;

/**
 * The import's `open_homes` cell, read on the property's clock: `2026-11-14 10:00-10:30; 2026-11-21 10:00-10:30`. A part it
 * cannot read is named for a warning, never a guess; the listing still imports.
 */
export function parseOpenHomesCell(raw: string, state: string): { slots: { startsAt: string; endsAt: string }[]; problems: string[] } {
  const timeZone = stateTimeZone(state);
  const slots: { startsAt: string; endsAt: string }[] = [];
  const problems: string[] = [];
  for (const part of raw.split(';').map((p) => p.trim()).filter(Boolean)) {
    const m = CELL_PART.exec(part);
    const startsAt = m ? localDateTimeToInstant(m[1]!, m[2]!, timeZone) : null;
    const endsAt = m ? localDateTimeToInstant(m[1]!, m[3]!, timeZone) : null;
    if (!startsAt || !endsAt || endsAt <= startsAt) {
      problems.push(`“${part.slice(0, 60)}” isn't in the expected format, so no time was added. Use 2026-11-14 10:00-10:30`);
      continue;
    }
    slots.push({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
  }
  return { slots, problems };
}
