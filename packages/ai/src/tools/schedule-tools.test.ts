import { MIN_INTERVAL_MINUTES, verifyScheduleDraft } from '@repo/core/schedules';
import type { Db } from '@repo/db';
import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from './context';
import { runCancelSchedule, runDraftSchedule } from './schedule-tools';

const SECRET = 'tool-test-secret';

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {} as Db,
    places: new Map(),
    resolvePlace: vi.fn(async () => null),
    search: vi.fn(async () => []),
    getListing: vi.fn(async () => null),
    nearbyMarket: vi.fn(async () => ({}) as never),
    lastSearch: { channel: 'rent', suburb: 'Pakenham', bedrooms: 3 },
    scheduling: {
      state: 'ready',
      draftSecret: SECRET,
      listSchedules: vi.fn(async () => []),
      pauseSchedule: vi.fn(async () => true),
    },
    ...over,
  };
}

describe('draft_schedule', () => {
  /**
   * The whole point of the tool: it proposes and stops.
   *
   * Nothing here touches a database, and the outcome carries a signed token
   * instead of an id — there is no row to have an id yet.
   */
  it('writes nothing and hands back a signed draft', async () => {
    const outcome = await runDraftSchedule({ cadence: 'daily' }, ctx());

    expect(outcome.isError).toBeUndefined();
    expect(outcome.scheduleDraft?.token).toBeTruthy();

    const claim = verifyScheduleDraft(outcome.scheduleDraft!.token, SECRET);
    expect(claim.ok).toBe(true);
    if (claim.ok) {
      expect(claim.draft.cadence).toBe('daily');
      // 8 PM, because an unstated time has to be some time.
      expect(claim.draft.sendAtMinute).toBe(20 * 60);
    }
  });

  /**
   * The search is `ctx.lastSearch`, never anything the model said. There is
   * no field in the tool schema for it, and this is the behavioural half of
   * that: the frozen path is the search that actually ran.
   */
  it('freezes the search that ran, not one the model describes', async () => {
    const outcome = await runDraftSchedule({ cadence: 'daily' }, ctx());
    const claim = verifyScheduleDraft(outcome.scheduleDraft!.token, SECRET);

    expect(claim.ok && claim.draft.searchPath).toContain('suburb=Pakenham');
    expect(claim.ok && claim.draft.searchPath).toContain('channel=rent');
    expect(claim.ok && claim.draft.searchPath).toContain('beds=3');
  });

  it('refuses when no search has run, rather than inventing one', async () => {
    const outcome = await runDraftSchedule({ cadence: 'daily' }, ctx({ lastSearch: undefined }));

    expect(outcome.isError).toBe(true);
    expect(outcome.scheduleDraft).toBeUndefined();
    expect(JSON.stringify(outcome.result)).toMatch(/No search has run/);
  });

  it('turns hours into an interval', async () => {
    const outcome = await runDraftSchedule({ cadence: 'interval', everyHours: 2 }, ctx());
    const claim = verifyScheduleDraft(outcome.scheduleDraft!.token, SECRET);

    expect(claim.ok && claim.draft.intervalMinutes).toBe(120);
    expect(outcome.scheduleDraft?.cadence).toBe('Every 2 hours');
  });

  /**
   * "Every 5 minutes" produces a real card reading "Every 10 minutes".
   *
   * It used to be refused, and the model narrated the refusal as success —
   * "a confirmation card should appear… every 5 minutes" with no card on
   * screen. Seen live. Clamping means there is always a card and the card
   * is always written by the server, so the truth does not depend on what
   * the model chooses to say about it.
   */
  it('clamps anything under the floor up to it, and still draws a card', async () => {
    const outcome = await runDraftSchedule({ cadence: 'interval', everyMinutes: 5 }, ctx());

    expect(outcome.isError).toBeUndefined();
    expect(outcome.scheduleDraft?.cadence).toBe('Every 10 minutes');

    const claim = verifyScheduleDraft(outcome.scheduleDraft!.token, SECRET);
    expect(claim.ok && claim.draft.intervalMinutes).toBe(MIN_INTERVAL_MINUTES);

    // And the model is told to say so rather than echo what was asked for.
    expect(outcome.result).toMatchObject({
      adjusted: { askedForMinutes: 5, usingMinutes: 10, using: 'Every 10 minutes' },
    });
    expect(JSON.stringify(outcome.result)).toMatch(/Never repeat the frequency they asked for/i);
  });

  /**
   * The reason `everyMinutes` exists.
   *
   * The floor is 10 minutes, which as `everyHours` is 0.1666…; the model
   * would have to derive that fraction and the clamp report would hand it
   * back one. Nothing the visitor ever reads should contain it.
   */
  it('takes a ten-minute gap in minutes, with no fraction anywhere', async () => {
    const outcome = await runDraftSchedule({ cadence: 'interval', everyMinutes: 10 }, ctx());

    expect(outcome.scheduleDraft?.cadence).toBe('Every 10 minutes');
    expect(outcome.result).not.toHaveProperty('adjusted');

    const claim = verifyScheduleDraft(outcome.scheduleDraft!.token, SECRET);
    expect(claim.ok && claim.draft.intervalMinutes).toBe(10);
    expect(JSON.stringify(outcome.result)).not.toMatch(/0\.16/);
  });

  /** Both units given: the one the visitor actually spoke in wins. */
  it('prefers everyMinutes over everyHours when the model sends both', async () => {
    const outcome = await runDraftSchedule(
      { cadence: 'interval', everyHours: 3, everyMinutes: 30 },
      ctx(),
    );

    const claim = verifyScheduleDraft(outcome.scheduleDraft!.token, SECRET);
    expect(claim.ok && claim.draft.intervalMinutes).toBe(30);
  });

  /**
   * The ceiling is gone, and this is the ordinary case it used to refuse.
   *
   * "Every two weeks" was clamped down to one week — silently changing a
   * fortnightly digest into a weekly one, which is twice the email somebody
   * asked for. `weekly` cannot express a fortnight, so the old advice to
   * "use weekly instead" was not advice, it was a different schedule.
   */
  it('accepts a fortnightly gap, unclamped', async () => {
    const outcome = await runDraftSchedule({ cadence: 'interval', everyHours: 336 }, ctx());

    expect(outcome.isError).toBeUndefined();
    expect(outcome.result).not.toHaveProperty('adjusted');

    const claim = verifyScheduleDraft(outcome.scheduleDraft!.token, SECRET);
    expect(claim.ok && claim.draft.intervalMinutes).toBe(14 * 24 * 60);
  });

  it('accepts a gap of a year', async () => {
    const outcome = await runDraftSchedule({ cadence: 'interval', everyHours: 24 * 365 }, ctx());

    expect(outcome.isError).toBeUndefined();
    const claim = verifyScheduleDraft(outcome.scheduleDraft!.token, SECRET);
    expect(claim.ok && claim.draft.intervalMinutes).toBe(365 * 24 * 60);
  });

  /**
   * The floor, on the other hand, is absolute — it is the one the tick
   * cannot keep a promise below.
   */
  it('has no gap below the floor, however it is asked for', async () => {
    for (const input of [
      { cadence: 'interval' as const, everyMinutes: 1 },
      { cadence: 'interval' as const, everyMinutes: 9 },
      { cadence: 'interval' as const, everyHours: 1 / 60 },
    ]) {
      const outcome = await runDraftSchedule(input, ctx());
      const claim = verifyScheduleDraft(outcome.scheduleDraft!.token, SECRET);
      expect(claim.ok && claim.draft.intervalMinutes).toBe(MIN_INTERVAL_MINUTES);
    }
  });

  it('reports no adjustment when the request was already in range', async () => {
    const outcome = await runDraftSchedule({ cadence: 'interval', everyHours: 2 }, ctx());
    expect(outcome.result).not.toHaveProperty('adjusted');
  });

  it('takes a weekday and a time for a weekly schedule', async () => {
    const outcome = await runDraftSchedule(
      { cadence: 'weekly', weekday: 6, atTime: '09:00', timezone: 'Australia/Perth' },
      ctx(),
    );
    const claim = verifyScheduleDraft(outcome.scheduleDraft!.token, SECRET);

    expect(claim.ok && claim.draft.sendOnWeekday).toBe(6);
    expect(claim.ok && claim.draft.sendAtMinute).toBe(9 * 60);
    expect(outcome.scheduleDraft?.cadence).toBe('Every Saturday at 9:00 AM, Perth time');
  });

  /** A zone the model invented must not reach the database. */
  it('falls back to Sydney for a timezone it does not know', async () => {
    const outcome = await runDraftSchedule(
      { cadence: 'daily', timezone: 'America/New_York' },
      ctx(),
    );
    const claim = verifyScheduleDraft(outcome.scheduleDraft!.token, SECRET);

    expect(claim.ok && claim.draft.timezone).toBe('Australia/Sydney');
  });

  it('tells the model not to claim the schedule is running', async () => {
    const outcome = await runDraftSchedule({ cadence: 'daily' }, ctx());
    expect(JSON.stringify(outcome.result)).toMatch(/Do not claim it is already running/);
  });

  /**
   * The bug this pins was seen in a real conversation. Both reasons used to
   * be a single absent object, so somebody who was simply not signed in was
   * told "scheduling isn't available at the moment" — false, unactionable,
   * and it reads as a broken feature when the fix takes ten seconds.
   *
   * Two situations that must not read the same, the way packages/smoke
   * already separates "you chose not to spend money" from "you asked to and
   * cannot".
   */
  it('tells a signed-out visitor to sign in, and never that it is unavailable', async () => {
    const outcome = await runDraftSchedule(
      { cadence: 'daily' },
      ctx({ scheduling: { state: 'signed_out' } }),
    );

    expect(outcome.isError).toBe(true);
    expect(outcome.scheduleDraft).toBeUndefined();
    expect(outcome.result).toMatchObject({ needsSignIn: true });

    const said = JSON.stringify(outcome.result);
    expect(said).toMatch(/not signed in/i);
    // Asserting the instruction, not banning a word: the message's whole job
    // is to stop the model reaching for "unavailable", so it necessarily
    // contains it. A blanket ban failed here for exactly that reason.
    expect(said).toMatch(/do not say .*unavailable/i);
    expect(said).toMatch(/sign in/i);
  });

  it('says it is switched off — and does NOT suggest signing in — when unconfigured', async () => {
    const outcome = await runDraftSchedule(
      { cadence: 'daily' },
      ctx({ scheduling: { state: 'unconfigured' } }),
    );

    expect(outcome.isError).toBe(true);
    expect(outcome.result).not.toMatchObject({ needsSignIn: true });
    // Sending somebody to sign in for a server-side misconfiguration wastes
    // their time and hides the real fault from whoever could fix it.
    expect(JSON.stringify(outcome.result)).not.toMatch(/sign in/i);
  });

  it('draws the same distinction when cancelling', async () => {
    const signedOut = await runCancelSchedule({}, ctx({ scheduling: { state: 'signed_out' } }));
    const off = await runCancelSchedule({}, ctx({ scheduling: { state: 'unconfigured' } }));

    expect(signedOut.result).toMatchObject({ needsSignIn: true });
    expect(off.result).not.toMatchObject({ needsSignIn: true });
  });
});

describe('cancel_schedule', () => {
  const schedules = [
    { id: 'a', name: 'Pakenham rentals', description: 'homes to rent in Pakenham', status: 'active' },
    { id: 'b', name: 'Bondi sales', description: 'homes for sale in Bondi', status: 'active' },
  ];

  it('pauses the one that matches', async () => {
    const pauseSchedule = vi.fn(async () => true);
    const outcome = await runCancelSchedule(
      { which: 'pakenham' },
      ctx({
        scheduling: { state: 'ready', draftSecret: SECRET, listSchedules: async () => schedules, pauseSchedule },
      }),
    );

    expect(pauseSchedule).toHaveBeenCalledWith('a');
    expect(outcome.result).toMatchObject({ paused: 1 });
  });

  /**
   * Guessing is the failure mode here: pausing the wrong alert is silent,
   * and the person only finds out when the email they wanted stops.
   */
  it('asks which, rather than guessing, when more than one matches', async () => {
    const pauseSchedule = vi.fn(async () => true);
    const outcome = await runCancelSchedule(
      { which: 'homes' },
      ctx({
        scheduling: { state: 'ready', draftSecret: SECRET, listSchedules: async () => schedules, pauseSchedule },
      }),
    );

    expect(pauseSchedule).not.toHaveBeenCalled();
    expect(outcome.result).toMatchObject({ paused: 0 });
    expect((outcome.result as { ambiguous: string[] }).ambiguous).toHaveLength(2);
  });

  it('pauses everything when the visitor named nothing', async () => {
    const pauseSchedule = vi.fn(async () => true);
    const outcome = await runCancelSchedule(
      {},
      ctx({
        scheduling: { state: 'ready', draftSecret: SECRET, listSchedules: async () => schedules, pauseSchedule },
      }),
    );

    expect(pauseSchedule).toHaveBeenCalledTimes(2);
    expect(outcome.result).toMatchObject({ paused: 2 });
  });

  it('lists what is running when nothing matched', async () => {
    const outcome = await runCancelSchedule(
      { which: 'toorak' },
      ctx({
        scheduling: {
          state: 'ready',
          draftSecret: SECRET,
          listSchedules: async () => schedules,
          pauseSchedule: async () => true,
        },
      }),
    );

    expect(outcome.result).toMatchObject({ paused: 0 });
    expect((outcome.result as { running: string[] }).running).toHaveLength(2);
  });

  /** Paused is reversible; that is why this tool needs no confirmation card. */
  it('says it paused rather than deleted', async () => {
    const outcome = await runCancelSchedule(
      { which: 'pakenham' },
      ctx({
        scheduling: {
          state: 'ready',
          draftSecret: SECRET,
          listSchedules: async () => schedules,
          pauseSchedule: async () => true,
        },
      }),
    );

    expect(JSON.stringify(outcome.result)).toMatch(/Paused, not deleted/);
  });

  it('ignores a schedule that is already paused', async () => {
    const outcome = await runCancelSchedule(
      {},
      ctx({
        scheduling: {
          state: 'ready',
          draftSecret: SECRET,
          listSchedules: async () => [{ ...schedules[0]!, status: 'paused' }],
          pauseSchedule: async () => true,
        },
      }),
    );

    expect(outcome.result).toMatchObject({ paused: 0 });
  });
});
