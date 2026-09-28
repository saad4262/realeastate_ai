import { z } from 'zod';
import { searchQueryToPath } from '@repo/core/listings';
import {
  describeCadence,
  describeDraft,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  scheduleDraftSchema,
  signScheduleDraft,
  type ScheduleDraft,
} from '@repo/core/schedules';
import type { ToolContext, ToolOutcome } from './context';

/**
 * What the model may say about a schedule.
 *
 * Note what is absent: the search. The model does not get to describe which
 * listings to watch, because the search it would describe is a sentence and
 * the search that runs is a query. `ctx.lastSearch` holds the query that
 * actually returned rows this turn, and that is the one that gets frozen —
 * the same rule as ADR 0010, one layer up.
 *
 * Times and intervals ARE the model's to extract. That is not a #4 problem:
 * #4 is about prices, medians and market figures, where a model-invented
 * number would be presented to somebody as a fact about the world. "Every
 * two hours" is the person's own instruction being parsed, and it is shown
 * straight back to them for confirmation before anything happens.
 */
export const draftScheduleInput = z.object({
  cadence: z.enum(['daily', 'weekly', 'interval']),
  /**
   * For `interval`, in hours. Kept because "every two hours" is how most
   * people say it and a float is how the model would answer.
   */
  everyHours: z.number().positive().max(24 * 365 * 50).optional(),
  /**
   * For `interval`, in minutes — and preferred over `everyHours` when both
   * arrive.
   *
   * Added when the floor dropped to 10 minutes. Ten minutes as `everyHours`
   * is 0.1666…, which is a fraction the model has to derive and then has to
   * describe; asking for the unit the visitor actually used removes both
   * steps. `everyHours` stays for the hours-and-up cases.
   */
  everyMinutes: z.number().positive().max(60 * 24 * 365 * 50).optional(),
  /** For `daily` and `weekly`. 24-hour clock, e.g. "20:00". */
  atTime: z
    .string()
    .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 20:00')
    .optional(),
  /** For `weekly`. 0 = Sunday. */
  weekday: z.number().int().min(0).max(6).optional(),
  /** An IANA Australian zone. Defaults to Sydney when the visitor has not said. */
  timezone: z.string().max(64).optional(),
});

export type DraftScheduleInput = z.infer<typeof draftScheduleInput>;

const AU_ZONES = new Set([
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Brisbane',
  'Australia/Adelaide',
  'Australia/Perth',
  'Australia/Hobart',
  'Australia/Darwin',
  'Australia/Broken_Hill',
  'Australia/Lord_Howe',
  'Australia/Eucla',
]);

function minutesFromTime(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const [h, m] = value.split(':').map(Number);
  if (h === undefined || m === undefined) return fallback;
  return h * 60 + m;
}

/**
 * Draft a schedule and hand back a card for the visitor to confirm.
 *
 * Writes nothing. The outcome carries a signed token the Accept button
 * returns; until somebody presses it there is no row anywhere.
 */
export async function runDraftSchedule(
  input: DraftScheduleInput,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (ctx.scheduling.state === 'signed_out') {
    return {
      isError: true,
      result: {
        needsSignIn: true,
        error:
          'The visitor is not signed in. Tell them scheduling needs an account, that it is free and takes a moment, and that their search is kept when they come back. Do not say scheduling is unavailable — it is available to them the moment they sign in.',
      },
    };
  }

  if (ctx.scheduling.state === 'unconfigured') {
    return {
      isError: true,
      result: {
        error:
          'Scheduled email is not switched on for this site. Apologise briefly, do not blame the visitor, and offer the search link so they can check back themselves.',
      },
    };
  }

  /**
   * The search comes from the last one that actually ran, not from the model.
   *
   * Without it there is nothing to schedule, and guessing would mean
   * emailing somebody results for a search nobody performed.
   *
   * It is frozen as a PATH rather than an object: `searchQueryToPath` drops
   * the resolved coordinates whenever a suburb is named, because /search
   * re-resolves the centre itself. So the draft stores "Pakenham + 30 km"
   * rather than a lat/lng snapshot that will be months stale by the time
   * the schedule runs — the same round trip the /search save path uses.
   */
  const query = ctx.lastSearch;
  if (!query) {
    return {
      isError: true,
      result: {
        error:
          'No search has run yet in this conversation. Search for what the visitor wants first, then offer to schedule it.',
      },
    };
  }

  const timezone =
    input.timezone && AU_ZONES.has(input.timezone) ? input.timezone : 'Australia/Sydney';

  let draft: ScheduleDraft;
  /**
   * Set when the requested frequency had to be moved into range.
   *
   * Stated in minutes and as a ready-made phrase, not in hours. Hours were
   * fine while the floor was an hour; with a 10-minute floor a clamped
   * "every 5 minutes" became `usingHours: 0.1666…`, and the model's job is
   * then to turn that back into English in front of the visitor. `using`
   * comes from the same `describeCadence` that writes the card, so what the
   * model says and what the card says cannot drift apart.
   */
  let adjusted:
    | { askedForMinutes: number; usingMinutes: number; using: string; reason: string }
    | undefined;

  if (input.cadence === 'interval') {
    // Minutes win: they are the unit the visitor used when they matter.
    const asked = Math.round(input.everyMinutes ?? (input.everyHours ?? 0) * 60);

    /**
     * Clamped into range, not refused.
     *
     * This used to return an error for anything under an hour, and the
     * model narrated it as success anyway — "a confirmation card should
     * appear… every 5 minutes", with no card on screen and no schedule.
     * Seen live. A prompt rule did not stop it and a sterner one would not
     * either: the model had already begun its sentence.
     *
     * So the tool always produces a real card, and the card always states
     * the frequency that will actually run. The model cannot claim a card
     * that is not there, because there is one; and it cannot misdescribe
     * it, because the card is written by the server. The adjustment is
     * reported so the model can explain it, but the truth no longer
     * depends on the model saying it.
     */
    const minutes = Math.min(Math.max(asked, MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);

    if (minutes !== asked) {
      adjusted = {
        askedForMinutes: asked,
        usingMinutes: minutes,
        using: describeCadence({
          cadence: 'interval',
          intervalMinutes: minutes,
          sendAtMinute: 0,
          timezone: 'Australia/Sydney',
        }),
        reason:
          asked < MIN_INTERVAL_MINUTES
            ? `The shortest gap this site can run is every ${MIN_INTERVAL_MINUTES} minutes.`
            : 'That gap is longer than this can store.',
      };
    }

    draft = {
      searchPath: searchQueryToPath(query),
      cadence: 'interval',
      // Carried but meaningless for an interval; the contract refuses a
      // weekday here and `nextRunFor` never reads the clock at all.
      sendAtMinute: 0,
      intervalMinutes: minutes,
      timezone: timezone as ScheduleDraft['timezone'],
    };
  } else {
    // 8 PM is the default because it is when people look at property, and
    // because an unstated time has to be *some* time.
    const sendAtMinute = minutesFromTime(input.atTime, 20 * 60);

    draft = {
      searchPath: searchQueryToPath(query),
      cadence: input.cadence,
      sendAtMinute,
      ...(input.cadence === 'weekly' ? { sendOnWeekday: input.weekday ?? 1 } : {}),
      timezone: timezone as ScheduleDraft['timezone'],
    };
  }

  const validated = scheduleDraftSchema.safeParse(draft);
  if (!validated.success) {
    return {
      isError: true,
      result: { error: 'That schedule is not one we can run. Ask the visitor to rephrase it.' },
    };
  }

  const described = describeDraft(validated.data);
  const token = signScheduleDraft(validated.data, ctx.scheduling.draftSecret);

  return {
    label: 'Preparing a schedule',
    /**
     * What the model is told is deliberately thin: that a card is on
     * screen, and what it says. It must not re-state the schedule in its
     * own words as though it were already running — nothing is saved yet.
     */
    result: {
      drafted: true,
      search: described.search,
      frequency: described.cadence,
      ...(adjusted ? { adjusted } : {}),
      note: adjusted
        ? `The card says "${described.cadence}", NOT what they asked for. ${adjusted.reason} Say that plainly and say what the card offers instead, then ask them to press Accept if it suits. Never repeat the frequency they asked for as though it were set.`
        : 'A confirmation card is now on screen. Tell the visitor to press Accept to start it. Do not claim it is already running.',
    },
    scheduleDraft: {
      token,
      search: described.search,
      cadence: described.cadence,
      searchPath: described.searchPath,
    },
  };
}

export const cancelScheduleInput = z.object({
  /**
   * Which one, in the visitor's words. Matched against the stored names by
   * the app, not by the model — and when it is ambiguous, nothing happens
   * and the visitor is asked which.
   */
  which: z.string().max(200).optional(),
});

export type CancelScheduleInput = z.infer<typeof cancelScheduleInput>;

/**
 * Pause a schedule the visitor asked to stop.
 *
 * **Pause, not delete**, and that is the reason this needs no confirmation
 * card while creating one does. Pausing is reversible in one click from
 * /alerts, so a model that misreads "cancel the Pakenham one" costs
 * somebody a resume rather than their saved search. Deleting is available
 * on /alerts, where the person can see exactly which row they are removing.
 */
export async function runCancelSchedule(
  input: CancelScheduleInput,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (ctx.scheduling.state === 'signed_out') {
    return {
      isError: true,
      result: {
        needsSignIn: true,
        error: 'The visitor is not signed in, so they have no saved searches here. Tell them to sign in.',
      },
    };
  }

  if (ctx.scheduling.state === 'unconfigured') {
    return {
      isError: true,
      result: { error: 'Saved searches are not switched on for this site.' },
    };
  }

  const scheduling = ctx.scheduling;
  const schedules = await scheduling.listSchedules();
  const active = schedules.filter((s) => s.status === 'active');

  if (active.length === 0) {
    return { result: { paused: 0, note: 'The visitor has no running saved searches.' } };
  }

  const wanted = input.which?.trim().toLowerCase();

  const matches = wanted
    ? active.filter(
        (s) => s.name.toLowerCase().includes(wanted) || s.description.toLowerCase().includes(wanted),
      )
    : active;

  /**
   * Ambiguity stops, rather than guessing.
   *
   * "Cancel my alert" with three running is not an instruction, it is the
   * start of one. Pausing the wrong one is a silent failure the person only
   * notices when the email they wanted stops arriving.
   */
  if (matches.length > 1 && wanted) {
    return {
      result: {
        paused: 0,
        ambiguous: matches.map((s) => s.name),
        note: 'More than one matches. Ask the visitor which of these they mean.',
      },
    };
  }

  if (matches.length === 0) {
    return {
      result: {
        paused: 0,
        running: active.map((s) => s.name),
        note: 'Nothing matched. Tell the visitor what is running and ask which to stop.',
      },
    };
  }

  const paused: string[] = [];
  for (const schedule of matches) {
    if (await scheduling.pauseSchedule(schedule.id)) paused.push(schedule.name);
  }

  return {
    label: 'Stopping a saved search',
    result: {
      paused: paused.length,
      names: paused,
      note: 'Paused, not deleted. Tell the visitor they can turn it back on from their alerts page.',
    },
  };
}
