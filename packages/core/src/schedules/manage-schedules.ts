import { and, count, desc, eq, sql } from 'drizzle-orm';
import { scheduleRun, searchSchedule, type DbOrTx, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import {
  describeSavedQuery,
  parseSearchParams,
  savedQueryToPath,
  savedSearchQuerySchema,
  type SavedSearchQuery,
} from '../listings/search-url';
import { verifyScheduleDraft, type ScheduleDraft } from './draft';
import { nextRunFor } from './next-run';
import {
  createScheduleSchema,
  MAX_SCHEDULES_PER_USER,
  updateScheduleSchema,
  type ScheduleCadence,
  type ScheduleStatus,
} from './schedule-schema';

/** The version of the save path that produced a row's stored query. */
export const SAVED_QUERY_VERSION = 'search-url@v1';

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly code: 'refused' | 'invalid' | 'limit' | 'not_found',
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

export type ScheduleSummary = {
  id: string;
  name: string;
  prompt: string | null;
  query: SavedSearchQuery;
  /** Server-authored words for the filters. Never model-written. */
  description: string;
  searchPath: string;
  cadence: ScheduleCadence;
  sendAtMinute: number;
  sendOnWeekday: number | null;
  intervalMinutes: number | null;
  timezone: string;
  status: ScheduleStatus;
  nextRunAt: Date;
  lastRunAt: Date | null;
  consecutiveFailures: number;
  createdAt: Date;
};

/**
 * `jsonb` has no shape, so every read parses.
 *
 * A row written by an older release can hold a filter this version no longer
 * knows. Throwing here is deliberate: the alternative is running a search
 * that quietly ignores part of what the person asked for and emailing them
 * the results as if it had not.
 */
function parseStoredQuery(raw: unknown, scheduleId: string): SavedSearchQuery {
  const parsed = savedSearchQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScheduleError(
      `Schedule ${scheduleId} has a stored query this version cannot read`,
      'invalid',
    );
  }
  return parsed.data;
}

/**
 * `unstable_cache` and `jsonb` both hand dates back as ISO strings while the
 * type still says Date — the class of bug ARCHITECTURE § 6 names. Coerce at
 * the boundary, and the tests assert the TYPE rather than the value.
 */
function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toSummary(row: typeof searchSchedule.$inferSelect): ScheduleSummary {
  const query = parseStoredQuery(row.query, row.id);
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt || null,
    query,
    description: describeSavedQuery(query),
    searchPath: savedQueryToPath(query),
    cadence: row.cadence,
    sendAtMinute: row.sendAtMinute,
    sendOnWeekday: row.sendOnWeekday,
    intervalMinutes: row.intervalMinutes,
    timezone: row.timezone,
    status: row.status,
    nextRunAt: asDate(row.nextRunAt),
    lastRunAt: row.lastRunAt ? asDate(row.lastRunAt) : null,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: asDate(row.createdAt),
  };
}

/** The resource shape `can()` decides schedule actions against. */
function resourceFor(ownerId: string, id?: string) {
  return id ? { type: 'schedule', id, ownerId } : { type: 'schedule', ownerId };
}

export type CreateScheduleResult = { id: string; schedule: ScheduleSummary };

/**
 * Save a search and the time to run it.
 *
 * The query is parsed out of `searchPath` here, on the server, rather than
 * accepted as filters from the browser. That is the enquiry-form rule
 * (ARCHITECTURE § 9) applied to a thing that will later send email in this
 * person's name: the browser chooses which search page it is looking at, and
 * the server decides what that means.
 *
 * No LLM is called. ADR 0010 — the prompt is a label, not an instruction.
 */
export async function createSchedule(
  db: Db,
  actor: Actor,
  input: unknown,
  opts: { now?: Date } = {},
): Promise<CreateScheduleResult> {
  if (!can(actor, 'schedule:create', resourceFor(actor.userId))) {
    throw new ScheduleError('You need an account to save a search', 'refused');
  }

  const parsed = createScheduleSchema.safeParse(input);
  if (!parsed.success) {
    throw new ScheduleError(
      parsed.error.issues[0]?.message ?? 'That schedule could not be saved',
      'invalid',
    );
  }
  const data = parsed.data;

  const queryString = data.searchPath.includes('?') ? data.searchPath.split('?')[1] : '';
  const query = parseSearchParams(new URLSearchParams(queryString ?? ''));

  /**
   * A schedule with no filters at all is "email me every listing, daily".
   *
   * It is a valid search page and a useless alert, and it is the one a person
   * creates by pressing save before they have searched for anything.
   */
  if (Object.keys(query).length === 0) {
    throw new ScheduleError('Add at least one filter before saving this search', 'invalid');
  }

  const now = opts.now ?? new Date();

  const nextRunAt = nextRunFor({
    cadence: data.cadence,
    sendAtMinute: data.sendAtMinute,
    timezone: data.timezone,
    sendOnWeekday: data.sendOnWeekday,
    intervalMinutes: data.intervalMinutes,
    after: now,
  });

  /**
   * Counted before the insert, and honestly not airtight.
   *
   * Two requests in the same millisecond can both read nine and both insert.
   * The ceiling is here to stop a person accumulating alerts by accident, not
   * to stop one determined to have eleven — and a unique constraint cannot
   * express "at most ten rows". Said plainly rather than implied, the same
   * way the chat's rate limiter is.
   */
  const [existing] = await db
    .select({ total: count() })
    .from(searchSchedule)
    .where(eq(searchSchedule.userId, actor.userId));

  if ((existing?.total ?? 0) >= MAX_SCHEDULES_PER_USER) {
    throw new ScheduleError(
      `You can have ${MAX_SCHEDULES_PER_USER} saved searches. Delete one to add another.`,
      'limit',
    );
  }

  const [row] = await db
    .insert(searchSchedule)
    .values({
      userId: actor.userId,
      name: data.name?.trim() || describeSavedQuery(query).slice(0, 120),
      prompt: data.prompt?.trim() ?? '',
      query,
      promptVersion: SAVED_QUERY_VERSION,
      cadence: data.cadence,
      sendAtMinute: data.sendAtMinute,
      sendOnWeekday: data.sendOnWeekday ?? null,
      intervalMinutes: data.intervalMinutes ?? null,
      timezone: data.timezone,
      nextRunAt,
    })
    .returning();

  if (!row) throw new ScheduleError('That schedule could not be saved', 'invalid');

  return { id: row.id, schedule: toSummary(row) };
}

/**
 * Accept a schedule the guide proposed in the chat.
 *
 * The browser hands back the signed token and nothing else. What gets
 * stored is what was inside the signature — the search and the frequency
 * the person read on the card — so pressing Accept cannot create a
 * different schedule from the one they agreed to. `createSchedule` then
 * re-parses the search path with the same vocabulary /search uses, exactly
 * as it does for the button on the results page.
 *
 * The token carries no user id: it authorises the CONTENT, and the session
 * decides whose it becomes. That is what lets an anonymous visitor be shown
 * a card, sign in, and accept it as themselves without it being reissued.
 */
export async function acceptScheduleDraft(
  db: Db,
  actor: Actor,
  token: string,
  secret: string,
  opts: { now?: Date } = {},
): Promise<CreateScheduleResult> {
  const claim = verifyScheduleDraft(token, secret);
  if (!claim.ok) {
    throw new ScheduleError('That schedule could not be confirmed. Ask the guide again.', 'invalid');
  }

  const draft: ScheduleDraft = claim.draft;

  return createSchedule(
    db,
    actor,
    {
      searchPath: draft.searchPath,
      ...(draft.prompt ? { prompt: draft.prompt } : {}),
      cadence: draft.cadence,
      sendAtMinute: draft.sendAtMinute,
      ...(draft.sendOnWeekday !== undefined ? { sendOnWeekday: draft.sendOnWeekday } : {}),
      ...(draft.intervalMinutes !== undefined ? { intervalMinutes: draft.intervalMinutes } : {}),
      timezone: draft.timezone,
    },
    opts,
  );
}

/** Every schedule this person owns, newest first. One statement. */
export async function listSchedules(db: Db, actor: Actor): Promise<ScheduleSummary[]> {
  if (!can(actor, 'schedule:read', resourceFor(actor.userId))) return [];

  const rows = await db
    .select()
    .from(searchSchedule)
    .where(eq(searchSchedule.userId, actor.userId))
    // createdAt alone is not unique, so the id is the tiebreaker (§ 5).
    .orderBy(desc(searchSchedule.createdAt), desc(searchSchedule.id));

  return rows.map(toSummary);
}

export async function getSchedule(
  db: Db,
  actor: Actor,
  id: string,
): Promise<ScheduleSummary | null> {
  const [row] = await db.select().from(searchSchedule).where(eq(searchSchedule.id, id)).limit(1);
  if (!row) return null;

  /**
   * Ownership is checked against the row that was read, not against the id
   * that was asked for.
   *
   * Filtering by `userId` in the WHERE would work and would also make every
   * refusal indistinguishable from a missing row. Reading first and asking
   * `can()` second keeps the decision in one place, which is the rule.
   */
  if (!can(actor, 'schedule:read', resourceFor(row.userId, row.id))) return null;

  return toSummary(row);
}

/**
 * Change the timing, the name, or whether it runs.
 *
 * The prompt and the query are not editable. Changing what is searched means
 * saving a new search from a new results page — ADR 0010 — because the point
 * of freezing the query is that the thing emailed is the thing that was
 * confirmed.
 */
export async function updateSchedule(
  db: Db,
  actor: Actor,
  id: string,
  input: unknown,
  opts: { now?: Date } = {},
): Promise<ScheduleSummary> {
  const parsed = updateScheduleSchema.safeParse(input);
  if (!parsed.success) {
    throw new ScheduleError(
      parsed.error.issues[0]?.message ?? 'That change could not be saved',
      'invalid',
    );
  }
  const patch = parsed.data;

  const [current] = await db
    .select()
    .from(searchSchedule)
    .where(eq(searchSchedule.id, id))
    .limit(1);

  if (!current) throw new ScheduleError('No such saved search', 'not_found');
  if (!can(actor, 'schedule:manage', resourceFor(current.userId, current.id))) {
    throw new ScheduleError('No such saved search', 'not_found');
  }

  const cadence = patch.cadence ?? current.cadence;
  const sendAtMinute = patch.sendAtMinute ?? current.sendAtMinute;
  const timezone = patch.timezone ?? current.timezone;
  const sendOnWeekday =
    patch.sendOnWeekday === undefined ? current.sendOnWeekday : patch.sendOnWeekday;
  const intervalMinutes =
    patch.intervalMinutes === undefined ? current.intervalMinutes : patch.intervalMinutes;

  // The cadence/weekday rule is checked on the MERGED row, because a patch
  // does not carry the cadence it is being applied to.
  if (cadence === 'weekly' && sendOnWeekday === null) {
    throw new ScheduleError('Choose which day of the week to send on', 'invalid');
  }
  if (cadence === 'interval' && intervalMinutes === null) {
    throw new ScheduleError('Say how many hours apart the runs should be', 'invalid');
  }
  // Only the field that belongs to this cadence survives the merge. Two
  // answers to "when does this fire" is worse than none.
  const weekday = cadence === 'weekly' ? sendOnWeekday : null;
  const interval = cadence === 'interval' ? intervalMinutes : null;

  const now = opts.now ?? new Date();
  const timingChanged =
    cadence !== current.cadence ||
    sendAtMinute !== current.sendAtMinute ||
    timezone !== current.timezone ||
    weekday !== current.sendOnWeekday ||
    interval !== current.intervalMinutes;

  const resuming = patch.status === 'active' && current.status !== 'active';

  /**
   * Recompute the cursor when the timing changed, and when a paused schedule
   * resumes.
   *
   * A schedule paused for a month has a `next_run_at` a month in the past. On
   * resume that is immediately due, so it would fire the moment the next tick
   * ran — at whatever time of day that happened to be, which is not the time
   * the person chose. Resuming re-anchors it to the next real slot.
   */
  const nextRunAt =
    timingChanged || resuming
      ? nextRunFor({
          cadence,
          sendAtMinute,
          timezone,
          sendOnWeekday: weekday ?? undefined,
          intervalMinutes: interval ?? undefined,
          after: now,
        })
      : current.nextRunAt;

  const [row] = await db
    .update(searchSchedule)
    .set({
      ...(patch.name ? { name: patch.name } : {}),
      cadence,
      sendAtMinute,
      sendOnWeekday: weekday,
      intervalMinutes: interval,
      timezone,
      ...(patch.status ? { status: patch.status } : {}),
      // Resuming clears the failure count: the person has looked at it.
      ...(resuming ? { consecutiveFailures: 0 } : {}),
      nextRunAt,
      updatedAt: sql`now()`,
    })
    .where(eq(searchSchedule.id, id))
    .returning();

  if (!row) throw new ScheduleError('No such saved search', 'not_found');
  return toSummary(row);
}

/** Delete a saved search and, by cascade, its run history. */
export async function deleteSchedule(db: Db, actor: Actor, id: string): Promise<void> {
  const [current] = await db
    .select({ id: searchSchedule.id, userId: searchSchedule.userId })
    .from(searchSchedule)
    .where(eq(searchSchedule.id, id))
    .limit(1);

  if (!current) throw new ScheduleError('No such saved search', 'not_found');
  if (!can(actor, 'schedule:manage', resourceFor(current.userId, current.id))) {
    // Deliberately the same message as a missing row. "You may not touch this"
    // confirms it exists and belongs to somebody.
    throw new ScheduleError('No such saved search', 'not_found');
  }

  await db.delete(searchSchedule).where(eq(searchSchedule.id, id));
}

/**
 * Stop a schedule from an emailed link, with no session.
 *
 * Takes a `DbOrTx` and no actor, because the person clicking is in a mail
 * client on a device that may never have signed in — the token is the
 * authorisation, and the caller has already verified it. The Spam Act does
 * not permit requiring a login to unsubscribe.
 */
export async function pauseScheduleByOwner(
  db: DbOrTx,
  scheduleId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .update(searchSchedule)
    .set({ status: 'paused', unsubscribedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(searchSchedule.id, scheduleId), eq(searchSchedule.userId, userId)))
    .returning({ id: searchSchedule.id });

  return rows.length > 0;
}

/** Everything this person has been sent, newest first. */
export async function listRunsForUser(
  db: Db,
  actor: Actor,
  opts: { limit?: number } = {},
): Promise<(typeof scheduleRun.$inferSelect)[]> {
  if (!can(actor, 'schedule:read', resourceFor(actor.userId))) return [];

  return db
    .select()
    .from(scheduleRun)
    .where(eq(scheduleRun.userId, actor.userId))
    .orderBy(desc(scheduleRun.createdAt), desc(scheduleRun.id))
    .limit(opts.limit ?? 25);
}
