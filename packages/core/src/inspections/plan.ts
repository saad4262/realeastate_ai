import { escapeIcsText, foldIcsLine } from '../appointments/ics';

/**
 * Inspection AI's day plan (ADR 0080, C6 decisions 1–3; mock docs/mocks/consumer-inspections.html). Pure.
 *
 * The times are the agents' open homes (the `inspection` table). The planner only picks one time per home, puts the
 * day in order and checks each stop: after the buyer's own time inside the last home and their own travel gap, how
 * much of the next open home is left. It never moves a time, never estimates driving (decision 2: there is no honest
 * number for it — only a straight-line distance from PostGIS, labelled so), and never drops a home silently: a home
 * that does not fit stays on the plan with its other times.
 */

export const MAX_PLAN_HOMES = 8;
export const GAP_OPTIONS = [10, 15, 20, 30, 45] as const;
export const INSIDE_OPTIONS = [5, 10, 15, 20] as const;
export const DEFAULT_GAP_MINUTES = 20;
export const DEFAULT_INSIDE_MINUTES = 10;
/** Past this many combinations of times the planner takes the earliest workable time per home instead. */
const MAX_COMBINATIONS = 20_000;

export type PlanSession = { id: string; startsAt: Date; endsAt: Date };
export type PlanHome = {
  listingId: string;
  /** "7 Test Road, Officer" */
  address: string;
  /** What a map and a calendar search for: "7 Test Road, Officer VIC 3809". */
  mapAddress: string;
  state: string;
  price: string;
  bedrooms: number | null;
  propertyType: string | null;
  /** Its upcoming open-for-inspection times, earliest first. */
  sessions: PlanSession[];
};
export type PlanSettings = { gapMinutes: number; insideMinutes: number };
/** Straight-line metres between two listings, from PostGIS; null when either has no pin. */
export type Distances = (a: string, b: string) => number | null;

export type StopStatus = 'start' | 'fits' | 'tight' | 'cant';
export type PlanStop = {
  home: PlanHome;
  session: PlanSession;
  status: StopStatus;
  /** When the buyer could be there: the open home's start, or the last stop plus their time inside and their gap. */
  arriveAt: Date;
  /** Minutes of the open home left on arrival (≤ 0: none). */
  minutesLeft: number;
  /** Straight line from the previous stop the buyer reaches; null for the first, or without a pin. */
  metresFromPrevious: number | null;
  /** The same home's other times that day — what "Use its other time" offers. */
  otherTimes: PlanSession[];
  /** For a stop the buyer cannot reach: the stop that is in the way. */
  conflictsWith: string | null;
};
export type NotThisDay = { home: PlanHome; reason: 'no_time_this_day' | 'time_removed' | 'another_day'; nextTime: PlanSession | null };
export type DayPlan = { day: string; timeZone: string; settings: PlanSettings; stops: PlanStop[]; notThisDay: NotThisDay[] };

const STATE_ZONE: Record<string, string> = {
  NSW: 'Australia/Sydney',
  ACT: 'Australia/Sydney',
  VIC: 'Australia/Melbourne',
  TAS: 'Australia/Hobart',
  QLD: 'Australia/Brisbane',
  SA: 'Australia/Adelaide',
  NT: 'Australia/Darwin',
  WA: 'Australia/Perth',
};

/** The zone an open home's times are read in. */
export function stateTimeZone(state: string): string {
  return STATE_ZONE[state.toUpperCase()] ?? 'Australia/Sydney';
}

/** YYYY-MM-DD of an instant in a zone. */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const MINUTE = 60_000;

export function clampSettings(input: Partial<PlanSettings> | undefined): PlanSettings {
  const gap = Number(input?.gapMinutes);
  const inside = Number(input?.insideMinutes);
  return {
    gapMinutes: (GAP_OPTIONS as readonly number[]).includes(gap) ? gap : DEFAULT_GAP_MINUTES,
    insideMinutes: (INSIDE_OPTIONS as readonly number[]).includes(inside) ? inside : DEFAULT_INSIDE_MINUTES,
  };
}

/** Walk the chosen times in order and check each stop. */
export function walkDay(chosen: readonly { home: PlanHome; session: PlanSession }[], settings: PlanSettings, distances: Distances, timeZone: string): PlanStop[] {
  const sorted = [...chosen].sort((a, b) => a.session.startsAt.getTime() - b.session.startsAt.getTime() || a.home.listingId.localeCompare(b.home.listingId));
  const stops: PlanStop[] = [];
  let last: { listingId: string; leaveAt: Date } | null = null;
  for (const { home, session } of sorted) {
    const day = localDay(session.startsAt, timeZone);
    const otherTimes = home.sessions.filter((s) => s.id !== session.id && localDay(s.startsAt, timeZone) === day);
    const earliest: number = last ? last.leaveAt.getTime() + settings.gapMinutes * MINUTE : session.startsAt.getTime();
    const arriveAt = new Date(Math.max(session.startsAt.getTime(), earliest));
    const minutesLeft = Math.floor((session.endsAt.getTime() - arriveAt.getTime()) / MINUTE);
    const status: StopStatus = !last ? 'start' : minutesLeft <= 0 ? 'cant' : minutesLeft < settings.insideMinutes ? 'tight' : 'fits';
    stops.push({ home, session, status, arriveAt, minutesLeft, metresFromPrevious: last ? distances(last.listingId, home.listingId) : null, otherTimes, conflictsWith: status === 'cant' ? last!.listingId : null });
    // A stop the buyer cannot reach does not hold up the next one.
    if (status !== 'cant') last = { listingId: home.listingId, leaveAt: new Date(arriveAt.getTime() + Math.min(settings.insideMinutes, minutesLeft) * MINUTE) };
  }
  return stops;
}

const score = (stops: readonly PlanStop[]) => {
  const cant = stops.filter((s) => s.status === 'cant').length;
  const tight = stops.filter((s) => s.status === 'tight').length;
  const finish = Math.max(0, ...stops.map((s) => s.session.endsAt.getTime()));
  return [cant, tight, finish] as const;
};
const better = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
};

/** The day most of the homes are open on (ties: the earliest), from today on. */
export function busiestDay(homes: readonly PlanHome[], timeZone: string): string | null {
  const count = new Map<string, number>();
  for (const h of homes) for (const d of new Set(h.sessions.map((s) => localDay(s.startsAt, timeZone)))) count.set(d, (count.get(d) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

const nextTime = (home: PlanHome, after: string, timeZone: string) => home.sessions.find((s) => localDay(s.startsAt, timeZone) > after) ?? null;

/**
 * Homes the buyer named, the planner picks the times: every combination of their times that day, the one with the
 * fewest stops they cannot reach, then the fewest tight ones, then the earliest finish.
 */
export function planAuto(homes: readonly PlanHome[], opts: { day?: string | null; settings: PlanSettings; distances: Distances; timeZone: string }): DayPlan {
  const day = opts.day ?? busiestDay(homes, opts.timeZone) ?? localDay(new Date(), opts.timeZone);
  const open = homes.map((home) => ({ home, times: home.sessions.filter((s) => localDay(s.startsAt, opts.timeZone) === day) }));
  const usable = open.filter((o) => o.times.length);
  const notThisDay: NotThisDay[] = open.filter((o) => !o.times.length).map((o) => ({ home: o.home, reason: 'no_time_this_day', nextTime: nextTime(o.home, day, opts.timeZone) }));

  const combinations = usable.reduce((n, o) => n * o.times.length, 1);
  let best: PlanStop[] = [];
  if (combinations <= MAX_COMBINATIONS) {
    let bestScore: readonly number[] | null = null;
    const pick: number[] = usable.map(() => 0);
    for (let k = 0; k < combinations; k++) {
      let rest = k;
      for (let i = 0; i < usable.length; i++) {
        pick[i] = rest % usable[i]!.times.length;
        rest = Math.floor(rest / usable[i]!.times.length);
      }
      const stops = walkDay(usable.map((o, i) => ({ home: o.home, session: o.times[pick[i]!]! })), opts.settings, opts.distances, opts.timeZone);
      const s = score(stops);
      if (!bestScore || better(s, bestScore)) {
        best = stops;
        bestScore = s;
      }
    }
  } else {
    best = walkDay(usable.map((o) => ({ home: o.home, session: o.times[0]! })), opts.settings, opts.distances, opts.timeZone);
  }
  return { day, timeZone: opts.timeZone, settings: opts.settings, stops: best, notThisDay };
}

/**
 * The times the buyer chose (a plan's link): the day is the earliest chosen time's. A chosen time the agent removed,
 * or one on another day, stays on the plan as "Not this day" with the home's next time.
 */
export function planChosen(homes: readonly PlanHome[], sessionIds: readonly string[], opts: { settings: PlanSettings; distances: Distances; timeZone: string }): DayPlan {
  const wanted = new Set(sessionIds);
  const chosen = homes.flatMap((home) => {
    const s = home.sessions.find((x) => wanted.has(x.id));
    return s ? [{ home, session: s }] : [];
  });
  const first = [...chosen].sort((a, b) => a.session.startsAt.getTime() - b.session.startsAt.getTime())[0];
  const day = first ? localDay(first.session.startsAt, opts.timeZone) : localDay(new Date(), opts.timeZone);
  const onDay = chosen.filter((c) => localDay(c.session.startsAt, opts.timeZone) === day);
  const notThisDay: NotThisDay[] = [
    ...chosen.filter((c) => !onDay.includes(c)).map((c) => ({ home: c.home, reason: 'another_day' as const, nextTime: c.session })),
    ...homes.filter((h) => !chosen.some((c) => c.home === h)).map((home) => ({ home, reason: 'time_removed' as const, nextTime: home.sessions[0] ?? null })),
  ];
  return { day, timeZone: opts.timeZone, settings: opts.settings, stops: walkDay(onDay, opts.settings, opts.distances, opts.timeZone), notThisDay };
}

/** The stops the buyer will actually reach. */
export const reachable = (plan: DayPlan) => plan.stops.filter((s) => s.status !== 'cant');

/** "3.8 km" — a straight line, rounded to 100 m. */
export function kmText(metres: number | null): string | null {
  return metres === null ? null : `${(Math.round(metres / 100) / 10).toFixed(1)} km`;
}

/** Google Maps with the stops in order (decision 3: a plain link, no API). */
export function routeUrl(plan: DayPlan): string | null {
  const stops = reachable(plan).map((s) => s.home.mapAddress);
  if (!stops.length) return null;
  if (stops.length === 1) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stops[0]!)}`;
  const q = new URLSearchParams({ api: '1', origin: stops[0]!, destination: stops[stops.length - 1]!, travelmode: 'driving' });
  if (stops.length > 2) q.set('waypoints', stops.slice(1, -1).join('|'));
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}

/**
 * The plan's own link: the homes, the chosen times and the buyer's settings. The homes ride along so a time the agent
 * later removes still names its home ("Not this day"), instead of vanishing with the deleted row.
 */
export function planQuery(plan: DayPlan): string {
  const homes = [...plan.stops.map((s) => s.home.listingId), ...plan.notThisDay.map((n) => n.home.listingId)];
  const q = new URLSearchParams({ l: [...new Set(homes)].join(','), s: plan.stops.map((s) => s.session.id).join(',') });
  if (plan.settings.gapMinutes !== DEFAULT_GAP_MINUTES) q.set('gap', String(plan.settings.gapMinutes));
  if (plan.settings.insideMinutes !== DEFAULT_INSIDE_MINUTES) q.set('inside', String(plan.settings.insideMinutes));
  return q.toString();
}

const utc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * One calendar file, an event per stop the buyer will reach (decision 3). The agent's times, not the planner's arrival:
 * the calendar says when the home is open. Times in UTC, so no VTIMEZONE block. One UID per open home, so a second
 * download updates the same events.
 */
export function planIcs(plan: DayPlan, opts: { now: Date; listingUrl: (listingId: string) => string }): string {
  const events = reachable(plan).flatMap((s) => [
    'BEGIN:VEVENT',
    `UID:inspection-${s.session.id}@property-platform`,
    `DTSTAMP:${utc(opts.now)}`,
    `DTSTART:${utc(s.session.startsAt)}`,
    `DTEND:${utc(s.session.endsAt)}`,
    `SUMMARY:${escapeIcsText(`Open home: ${s.home.address}`)}`,
    `DESCRIPTION:${escapeIcsText(`${s.home.price}. Times are set by the agent and can change: check the listing before you go. ${opts.listingUrl(s.home.listingId)}`)}`,
    `LOCATION:${escapeIcsText(s.home.mapAddress)}`,
    `URL:${opts.listingUrl(s.home.listingId)}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
  ]);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Property Platform//Inspections//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...events, 'END:VCALENDAR'];
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

/** "9:30 am" in the plan's zone. */
export function timeText(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(at).replace(/\s+/g, ' ').toLowerCase();
}

/** "Saturday 14 November" for the plan's day (YYYY-MM-DD, read at noon UTC so no zone moves it). */
export function dayText(day: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${day}T12:00:00Z`));
}
