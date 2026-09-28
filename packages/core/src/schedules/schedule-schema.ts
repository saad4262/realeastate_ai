import { z } from 'zod';
import { savedSearchQuerySchema } from '../listings/search-url';
import { AU_TIMEZONES as AU_TIMEZONES_VALUES } from './timezones';

/**
 * The contract for a saved, scheduled search.
 *
 * Read ADR 0010 before changing anything here. The load-bearing decision is
 * that a schedule stores a RESOLVED QUERY, not a prompt to re-interpret: the
 * model reads the sentence once, at save time, and every run after that is
 * SQL. These schemas are what make that storable and what make it safe to read
 * back out of a jsonb column.
 *
 * The four vocabularies below mirror pgEnums in packages/db/schema.ts —
 * `schedule_cadence`, `schedule_status`, `delivery_status` and `au_timezone`
 * — and are written out again rather than derived from them. Importing
 * `@repo/db` here would pull postgres.js into any client component that
 * imports this contract to validate a form, which is a build failure this repo
 * has already had once. `schedule-schema.test.ts` asserts each list against
 * its enum, so the duplication cannot drift; a test file may import `@repo/db`
 * freely because it never ships. Same trade, and same reason, as the "Mirrors
 * listing_channel" comments in ../listings/listing-schema.ts.
 */

/**
 * How often a schedule fires.
 *
 * A closed vocabulary rather than a cron expression, and rather than the
 * `varchar(32)` the old unused `saved_search.frequency` column used. Two
 * reasons: a filterable dimension is never free text (ARCHITECTURE § 7), and a
 * cron expression is a language the person would have to learn in order to say
 * "every morning". `nextRunFor` in ./next-run.ts is the only thing that turns
 * one of these into an instant.
 */
export const SCHEDULE_CADENCES = ['daily', 'weekly', 'interval'] as const;
export const scheduleCadenceSchema = z.enum(SCHEDULE_CADENCES);
export type ScheduleCadence = z.infer<typeof scheduleCadenceSchema>;

/**
 * `failing` is not a kind of `paused`.
 *
 * Paused is a decision someone made — they unsubscribed, or they switched it
 * off. Failing is the system giving up after three consecutive errors. They
 * read identically on a dashboard and they mean opposite things: one needs
 * nothing, the other needs somebody to look. Merging them is how a broken
 * alert becomes a silent one.
 */
export const SCHEDULE_STATUSES = ['active', 'paused', 'failing'] as const;
export const scheduleStatusSchema = z.enum(SCHEDULE_STATUSES);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

/** Per-channel delivery outcome for one run. `skipped` is a budget refusal. */
export const DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

/**
 * The zones, from ./timezones.ts — a module with no imports at all.
 *
 * Kept there rather than here so a `<select>` in a client component can have
 * the list without zod and the saved-query schema graph coming with it. That
 * cost `/chat` 17 kB of First Load before it was measured and moved.
 */
export { AU_TIMEZONES, timezoneLabel, type AuTimezone } from './timezones';
export const auTimezoneSchema = z.enum(AU_TIMEZONES_VALUES);

/**
 * Local wall-clock time of day, as minutes past midnight.
 *
 * Deliberately not a timestamp and not a string. "8 PM" is 1200 and it stays
 * 1200 through a daylight-saving change, which is what the person meant when
 * they said 8 PM. Storing an instant instead would pin them to one side of the
 * transition forever.
 */
export const sendAtMinuteSchema = z.number().int().min(0).max(1439);

/**
 * Which day a weekly schedule fires on. 0 = Sunday, matching `Date#getDay`.
 *
 * Nullable in the database and required-when-weekly in the contract below,
 * rather than defaulted. "Weekly" with no day named is not a schedule anyone
 * chose, and picking Monday on their behalf is a decision that then looks like
 * theirs.
 */
export const sendOnWeekdaySchema = z.number().int().min(0).max(6);

/**
 * The floor on an interval, in minutes.
 *
 * Tied to the cron tick, and it has to stay tied to it. The tick runs every
 * 5 minutes, so anything finer than that is a promise the scheduler cannot
 * keep no matter what the card says.
 *
 * 10 rather than 5, because the floor and the tick must not be equal.
 * `nextRunFor` advances an interval schedule exactly one slot from the slot
 * it just ran, so a row catches up at one slot per tick. With a 10-minute
 * floor and a 5-minute tick that is 2:1 and an outage drains; at 5 and 5 it
 * is 1:1 and a schedule that falls behind stays behind for ever. The ratio
 * is the invariant — move one of these two numbers and the other has to
 * move with it.
 */
export const MIN_INTERVAL_MINUTES = 10;

/**
 * A storage ceiling, not a product limit.
 *
 * There used to be a real maximum here — one week, on the reasoning that
 * `weekly` was the better shape past that. It was wrong in an ordinary case:
 * fortnightly. Somebody who wants a market round-up every two weeks, or a
 * reminder every quarter, is asking for something perfectly sensible that
 * `weekly` cannot express, and refusing it taught them the feature could not
 * do it rather than that this file had an opinion.
 *
 * So the only bound left is the column's: `interval_minutes` is a Postgres
 * `integer`, and a value above 2147483647 is an insert error rather than a
 * decision. It is ~4000 years, so nothing a person types will meet it — but
 * a bound that exists in the contract fails with a sentence, where the same
 * bound discovered at the database fails with a stack trace.
 *
 * The FLOOR is the real rule and it is strict: see MIN_INTERVAL_MINUTES.
 */
export const MAX_INTERVAL_MINUTES = 2_147_483_647;

export const intervalMinutesSchema = z
  .number()
  .int()
  .min(MIN_INTERVAL_MINUTES, { message: 'The shortest gap we can run is every 10 minutes' })
  .max(MAX_INTERVAL_MINUTES, { message: 'That gap is longer than this can store' });

/**
 * Daily has no weekday; weekly must have one.
 *
 * Applied as a refinement rather than a union so the error lands on the field
 * the person can fix. The same rule is enforced again by `nextRunFor`, which
 * throws on a weekly schedule with no weekday — a contract and the function
 * that depends on it should both refuse, because only one of them is in the
 * path when a row is read back out of the database.
 */
function withCadenceRules<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<T> {
  return schema.superRefine((value, ctx) => {
    const v = value as {
      cadence?: ScheduleCadence;
      sendOnWeekday?: number | null;
      intervalMinutes?: number | null;
    };

    const hasWeekday = v.sendOnWeekday !== undefined && v.sendOnWeekday !== null;
    const hasInterval = v.intervalMinutes !== undefined && v.intervalMinutes !== null;

    if (v.cadence === 'weekly' && !hasWeekday) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sendOnWeekday'],
        message: 'Choose which day of the week to send on',
      });
    }
    if (v.cadence !== 'weekly' && hasWeekday) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sendOnWeekday'],
        message: 'Only a weekly schedule takes a weekday',
      });
    }

    if (v.cadence === 'interval' && !hasInterval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['intervalMinutes'],
        message: 'Say how far apart the runs should be',
      });
    }
    /**
     * A daily schedule carrying an interval is not a harmless extra field.
     * It is two different answers to "when does this fire", and whichever
     * one `nextRunFor` happened to read would be the one nobody chose.
     */
    if (v.cadence !== 'interval' && hasInterval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['intervalMinutes'],
        message: 'Only an interval schedule takes a gap',
      });
    }
  });
}

/** 1200 → "8:00 PM". Display only; never a decision. */
export function sendAtLabel(minute: number): string {
  const hour24 = Math.floor(minute / 60);
  const mins = minute % 60;
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(mins).padStart(2, '0')} ${suffix}`;
}

/**
 * The frozen query, as something that can be parsed rather than asserted.
 *
 * Re-exported from ../listings/search-url.ts, where the URL vocabulary lives,
 * because a saved search and a `/search?…` link are the same thing written
 * two ways. Defining a second shape here is how they would drift.
 *
 * It matters that this is parsed and not cast. The column is `jsonb`, which
 * has no shape, and the row may have been written months and several releases
 * ago. Casting it would mean a schedule saved before a filter was renamed
 * silently searches without that filter — and emails somebody homes they
 * never asked for. `.strict()`, so that is a loud failure at the one moment
 * anybody can still act on it.
 */
export { savedSearchQuerySchema, type SavedSearchQuery } from '../listings/search-url';

/**
 * What the browser may send to create a schedule.
 *
 * It may not send the query as an object of filters. It sends the `/search?…`
 * path it is looking at, and the server parses that with the same vocabulary
 * `/search` itself parses — so the filters that get saved are the ones that
 * produced the results on screen, and the centre of any radius is resolved
 * server-side at run time rather than taken from the URL (ARCHITECTURE § 9,
 * and the bug that was reported twice about a radius drawn around the wrong
 * suburb).
 *
 * It may not send `userId`. That comes from the session.
 */
export const createScheduleSchema = withCadenceRules(
  z
    .object({
      /**
       * The `/search?…` path this was saved from.
       *
       * Relative and on `/search` only — checked here rather than trusted,
       * because it is a browser-supplied path that the server will parse and
       * later turn into a link inside an email.
       */
      searchPath: z
        .string()
        .trim()
        .max(2000)
        .refine((v) => v.startsWith('/search?') || v === '/search', {
          message: 'Not a search link',
        }),
      /** The sentence the person typed, if they came from the chat. Display only. */
      prompt: z.string().trim().max(1000).optional(),
      /** What the person calls it in their list. Derived from the query when blank. */
      name: z.string().trim().max(120).optional(),
      cadence: scheduleCadenceSchema,
      sendAtMinute: sendAtMinuteSchema,
      sendOnWeekday: sendOnWeekdaySchema.optional(),
      intervalMinutes: intervalMinutesSchema.optional(),
      timezone: auTimezoneSchema,
    })
    .strict(),
);

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

/**
 * What may be changed after the fact.
 *
 * The prompt is not in here, and that is the point of ADR 0010: changing the
 * sentence means re-resolving the query, which is a model call and a new
 * confirmation, not a field edit. `status` accepts only the two a person can
 * choose — nobody sets their own schedule to `failing`.
 */
export const updateScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    cadence: scheduleCadenceSchema.optional(),
    sendAtMinute: sendAtMinuteSchema.optional(),
    /**
     * Nullable as well as optional: absent means "leave it", `null` means
     * "clear it", and the two are different when switching weekly → daily.
     * The cadence/weekday rule is not checked here because a patch does not
     * carry the cadence it is being applied to — `updateSchedule` merges this
     * onto the stored row and validates the result.
     */
    sendOnWeekday: sendOnWeekdaySchema.nullable().optional(),
    intervalMinutes: intervalMinutesSchema.nullable().optional(),
    timezone: auTimezoneSchema.optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .strict();

export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;

/**
 * How many schedules one account may hold.
 *
 * Every one of these is a recurring email and a recurring model call against a
 * budget nobody watches per-account. A ceiling stated here is a ceiling the
 * create path can cite in its refusal; without one the first person to write a
 * loop owns the sending reputation of the domain.
 */
export const MAX_SCHEDULES_PER_USER = 10;
