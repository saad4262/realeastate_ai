import type { ScheduleCadence } from './schedule-schema';

/**
 * When does this schedule fire next?
 *
 * The whole feature rests on this file, and it is the one part of it that has
 * no external dependency at all — no date library, no database, no clock of
 * its own. Everything comes in as an argument so every case below can be a
 * unit test rather than something you find out about in October.
 *
 * ## Why this is not one line of arithmetic
 *
 * "Every day at 8 PM" is a statement about a wall clock, not about elapsed
 * time. Adding 24 hours to the last run is wrong twice a year in every
 * Australian state that observes daylight saving: the schedule slides to 7 PM
 * or 9 PM and stays there. So the local calendar date is advanced, and the UTC
 * instant is recomputed from scratch against that date's actual offset.
 *
 * Australia makes this worse than average. Five distinct behaviours have to
 * work: DST (Sydney, Melbourne, Hobart, Adelaide), no DST (Brisbane, Perth,
 * Darwin), a half-hour base offset (Adelaide, Darwin, Broken Hill), a
 * three-quarter-hour one (Eucla), and Lord Howe Island, whose DST shift is
 * thirty minutes rather than an hour. None of them is special-cased here —
 * the offset is asked for, never assumed.
 */

/** Days to look ahead before giving up. A weekly schedule needs at most 8. */
const MAX_LOOKAHEAD_DAYS = 8;

type LocalParts = {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday, matching Date.prototype.getDay. */
  weekday: number;
  minuteOfDay: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** What clock and calendar a person in `timeZone` sees at this instant. */
export function localPartsIn(instant: Date, timeZone: string): LocalParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  // `hour12: false` renders midnight as "24" in some ICU versions and "00" in
  // others. Both mean the same instant; only one of them is a number of hours.
  const hour = Number(get('hour')) % 24;

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    minuteOfDay: hour * 60 + Number(get('minute')),
  };
}

/**
 * How far ahead of UTC `timeZone` is at this instant, in milliseconds.
 *
 * Derived by asking what the wall clock reads there and subtracting. That is
 * the only way to get it right without shipping a copy of the tz database:
 * the rules change by legislation, and the platform's copy is the one that is
 * kept current.
 */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );

  // Seconds resolution is all formatToParts gives, so drop the milliseconds on
  // both sides rather than letting them show up as a spurious offset.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant at which a given wall-clock time occurs in a given zone.
 *
 * A wall-clock time is not a unique instant. Twice a year it is either two
 * instants or none, so this cannot be a subtraction — it has to try the
 * candidate offsets and check which of them actually round-trips.
 *
 * The offsets in force a day either side bracket any transition in between.
 * For each, the instant it implies is computed and then verified by asking
 * what the zone reads there; an offset that does not reproduce itself is one
 * that belongs to the other side of a transition, and its candidate is not a
 * real moment.
 *
 * ## The two days a year this has to choose
 *
 * **Autumn back.** 2:00-3:00 AM local happens twice, so both candidates verify
 * and the **earlier** is taken. Combined with the strict `> after` test in
 * `nextRunFor`, the schedule fires once rather than twice — which is what
 * "daily" promises.
 *
 * **Spring forward.** 2:00-3:00 AM local does not exist; neither candidate
 * verifies. Interpreting the requested time with the pre-transition offset
 * lands just past the gap, so a 2:30 AM schedule fires at 3:30 AM that day:
 * once, an hour late by the wall clock, rather than not at all.
 *
 * This is the disambiguation `Temporal` calls `compatible`, and it is the same
 * choice every other scheduler makes. It is spelled out because the
 * alternative — skipping a day, or sending twice — is the kind of thing that
 * gets discovered by a customer.
 */
export function instantForLocalTime(
  local: { year: number; month: number; day: number },
  minuteOfDay: number,
  timeZone: string,
): Date {
  const wallAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
  );

  const offsetBefore = offsetMsAt(new Date(wallAsUtc - DAY_MS), timeZone);
  const offsetAfter = offsetMsAt(new Date(wallAsUtc + DAY_MS), timeZone);

  const candidates = offsetBefore === offsetAfter ? [offsetBefore] : [offsetBefore, offsetAfter];

  const real = candidates
    .map((offset) => wallAsUtc - offset)
    .filter((instant) => offsetMsAt(new Date(instant), timeZone) === wallAsUtc - instant);

  if (real.length > 0) return new Date(Math.min(...real));

  // The gap. Nothing verified, so the requested clock reading never happened.
  return new Date(wallAsUtc - offsetBefore);
}

/** Advance a calendar date by whole days, without touching a clock. */
function addLocalDays(
  local: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const stepped = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return {
    year: stepped.getUTCFullYear(),
    month: stepped.getUTCMonth() + 1,
    day: stepped.getUTCDate(),
  };
}

export type NextRunInput = {
  cadence: ScheduleCadence;
  /** Local wall-clock minutes past midnight, 0-1439. */
  sendAtMinute: number;
  /** IANA zone name. An offset will not do — see schedule-schema.ts. */
  timezone: string;
  /** 0 = Sunday. Required for `weekly`, ignored otherwise. */
  sendOnWeekday?: number | undefined;
  /** Elapsed minutes between runs. Required for `interval`, ignored otherwise. */
  intervalMinutes?: number | undefined;
  /** The cursor is always strictly after this. Pass the run's own start. */
  after: Date;
};

/**
 * The next instant this schedule should fire, strictly after `after`.
 *
 * Strictly, because this is called immediately after a run completes and the
 * run's own slot must not be selected again — an equal comparison here is an
 * infinite loop that sends the same email until someone notices the bill.
 *
 * Walks forward a local calendar day at a time rather than adding a fixed
 * duration, so each candidate is resolved against the offset actually in force
 * on that date.
 */
export function nextRunFor(input: NextRunInput): Date {
  const { cadence, sendAtMinute, timezone, sendOnWeekday, intervalMinutes, after } = input;

  /**
   * An interval is elapsed time and has no wall clock in it.
   *
   * No timezone, no local calendar, no DST correction — and that is not an
   * omission. "Every two hours" means two hours; on the morning the clock
   * goes forward there is simply one fewer gap in the day, which is what
   * the person meant. Resolving it against a wall clock, as `daily` must
   * be, is what would make it fire twice at 2 AM once a year.
   */
  if (cadence === 'interval') {
    if (!Number.isInteger(intervalMinutes) || (intervalMinutes ?? 0) < 1) {
      throw new RangeError('An interval schedule needs intervalMinutes');
    }
    return new Date(after.getTime() + (intervalMinutes as number) * 60_000);
  }

  if (!Number.isInteger(sendAtMinute) || sendAtMinute < 0 || sendAtMinute > 1439) {
    throw new RangeError(`sendAtMinute must be 0-1439, got ${sendAtMinute}`);
  }

  if (cadence === 'weekly' && (sendOnWeekday === undefined || sendOnWeekday === null)) {
    // A weekly schedule with no weekday has no meaning, and picking one here
    // would invent a decision the person never made.
    throw new RangeError('A weekly schedule needs sendOnWeekday');
  }

  const startOfSearch = localPartsIn(after, timezone);

  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    const date = addLocalDays(startOfSearch, offset);
    const candidate = instantForLocalTime(date, sendAtMinute, timezone);

    if (candidate.getTime() <= after.getTime()) continue;

    if (cadence === 'weekly') {
      // Read the weekday back off the resolved instant rather than computing
      // it, so a candidate that crossed a date boundary on its way through the
      // offset is judged by the day it actually lands on.
      const landed = localPartsIn(candidate, timezone);
      if (landed.weekday !== sendOnWeekday) continue;
    }

    return candidate;
  }

  /* c8 ignore next 5 */
  // Unreachable: a daily schedule matches within 2 days and a weekly one
  // within 8. If this ever throws, a zone has been passed that Intl does not
  // know, and failing loudly beats returning a plausible wrong time.
  throw new Error(`Could not find a next run for ${cadence} in ${timezone}`);
}
