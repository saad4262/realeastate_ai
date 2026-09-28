import { describe, expect, it } from 'vitest';
import { instantForLocalTime, localPartsIn, nextRunFor } from './next-run';

/**
 * These are the tests the feature actually rests on.
 *
 * Everything else in the scheduler is a database write or an HTTP call and
 * fails loudly. This is the part that can be wrong by exactly one hour for
 * five months and look completely fine, so the cases below are the calendar
 * dates on which it would be wrong rather than a round-trip through a
 * convenient Tuesday.
 *
 * Australian DST 2026: clocks go FORWARD on Sunday 4 October 2026 at 2am, and
 * BACK on Sunday 5 April 2026 at 3am, in NSW/VIC/SA/TAS/ACT.
 */

/** What a person in `tz` reads on the clock at this instant. */
function wallClock(instant: Date, tz: string): string {
  const p = localPartsIn(instant, tz);
  const hh = String(Math.floor(p.minuteOfDay / 60)).padStart(2, '0');
  const mm = String(p.minuteOfDay % 60).padStart(2, '0');
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${hh}:${mm}`;
}

const EIGHT_PM = 20 * 60;

describe('nextRunFor', () => {
  it('fires at 8 PM local on the next day when today has passed', () => {
    // 9 PM Melbourne on 15 June (no DST in June — AEST, +10).
    const after = new Date('2026-06-15T11:00:00Z');
    const next = nextRunFor({
      cadence: 'daily',
      sendAtMinute: EIGHT_PM,
      timezone: 'Australia/Melbourne',
      after,
    });

    expect(wallClock(next, 'Australia/Melbourne')).toBe('2026-06-16 20:00');
    expect(next.toISOString()).toBe('2026-06-16T10:00:00.000Z');
  });

  it('fires later today when the hour has not passed yet', () => {
    // 6 AM Melbourne. 8 PM today is still ahead.
    const after = new Date('2026-06-15T20:00:00Z');
    const next = nextRunFor({
      cadence: 'daily',
      sendAtMinute: EIGHT_PM,
      timezone: 'Australia/Melbourne',
      after,
    });

    expect(wallClock(next, 'Australia/Melbourne')).toBe('2026-06-16 20:00');
  });

  /**
   * The case the whole file exists for.
   *
   * Across the spring-forward boundary the gap between consecutive 8 PMs is
   * 23 hours, not 24. Anything that adds a fixed day lands at 9 PM here and
   * stays there until April.
   */
  it('keeps 8 PM at 8 PM across spring forward (Melbourne, 4 Oct 2026)', () => {
    const saturdayEvening = new Date('2026-10-03T10:00:01Z'); // 8:00:01 PM AEST Sat 3 Oct
    const next = nextRunFor({
      cadence: 'daily',
      sendAtMinute: EIGHT_PM,
      timezone: 'Australia/Melbourne',
      after: saturdayEvening,
    });

    expect(wallClock(next, 'Australia/Melbourne')).toBe('2026-10-04 20:00');
    // AEDT is +11, so 8 PM local is 09:00Z — one hour earlier in UTC than the
    // day before, which is exactly the shift a naive +24h would have missed.
    expect(next.toISOString()).toBe('2026-10-04T09:00:00.000Z');
    expect(next.getTime() - saturdayEvening.getTime()).toBeLessThan(24 * 3600 * 1000);
  });

  it('keeps 8 PM at 8 PM across autumn back (Melbourne, 5 Apr 2026)', () => {
    const saturdayEvening = new Date('2026-04-04T09:00:01Z'); // 8:00:01 PM AEDT Sat 4 Apr
    const next = nextRunFor({
      cadence: 'daily',
      sendAtMinute: EIGHT_PM,
      timezone: 'Australia/Melbourne',
      after: saturdayEvening,
    });

    expect(wallClock(next, 'Australia/Melbourne')).toBe('2026-04-05 20:00');
    expect(next.toISOString()).toBe('2026-04-05T10:00:00.000Z');
    expect(next.getTime() - saturdayEvening.getTime()).toBeGreaterThan(24 * 3600 * 1000);
  });

  it('does not shift a Brisbane schedule, which has no DST', () => {
    const before = new Date('2026-10-03T10:00:01Z'); // 8:00:01 PM AEST
    const next = nextRunFor({
      cadence: 'daily',
      sendAtMinute: EIGHT_PM,
      timezone: 'Australia/Brisbane',
      after: before,
    });

    expect(wallClock(next, 'Australia/Brisbane')).toBe('2026-10-04 20:00');
    // Exactly 24 hours, because nothing moved.
    expect(next.getTime() - before.getTime()).toBe(24 * 3600 * 1000 - 1000);
  });

  it('handles a half-hour zone (Adelaide)', () => {
    // 6:30 AM Adelaide — 8 PM the same day is still ahead.
    const after = new Date('2026-06-14T21:00:00Z');
    const next = nextRunFor({
      cadence: 'daily',
      sendAtMinute: EIGHT_PM,
      timezone: 'Australia/Adelaide',
      after,
    });

    expect(wallClock(next, 'Australia/Adelaide')).toBe('2026-06-15 20:00');
    // ACST is +9:30, so 8 PM local is 10:30Z.
    expect(next.toISOString()).toBe('2026-06-15T10:30:00.000Z');
  });

  it('handles the 45-minute zone (Eucla)', () => {
    const after = new Date('2026-06-15T00:00:00Z');
    const next = nextRunFor({
      cadence: 'daily',
      sendAtMinute: EIGHT_PM,
      timezone: 'Australia/Eucla',
      after,
    });

    expect(wallClock(next, 'Australia/Eucla')).toBe('2026-06-15 20:00');
    // +8:45.
    expect(next.toISOString()).toBe('2026-06-15T11:15:00.000Z');
  });

  it('handles Lord Howe, whose DST shift is thirty minutes', () => {
    const june = nextRunFor({
      cadence: 'daily',
      sendAtMinute: EIGHT_PM,
      timezone: 'Australia/Lord_Howe',
      after: new Date('2026-06-15T00:00:00Z'),
    });
    const january = nextRunFor({
      cadence: 'daily',
      sendAtMinute: EIGHT_PM,
      timezone: 'Australia/Lord_Howe',
      after: new Date('2026-01-15T00:00:00Z'),
    });

    expect(wallClock(june, 'Australia/Lord_Howe')).toBe('2026-06-15 20:00');
    expect(wallClock(january, 'Australia/Lord_Howe')).toBe('2026-01-15 20:00');

    // +10:30 in winter, +11:00 in summer — a half-hour shift, not a whole one.
    expect(june.toISOString()).toBe('2026-06-15T09:30:00.000Z');
    expect(january.toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  it('never returns the instant it was given, so a run cannot re-select its own slot', () => {
    const exactlyEightPm = new Date('2026-06-15T10:00:00.000Z');
    const next = nextRunFor({
      cadence: 'daily',
      sendAtMinute: EIGHT_PM,
      timezone: 'Australia/Melbourne',
      after: exactlyEightPm,
    });

    expect(next.getTime()).toBeGreaterThan(exactlyEightPm.getTime());
    expect(wallClock(next, 'Australia/Melbourne')).toBe('2026-06-16 20:00');
  });

  describe('weekly', () => {
    it('lands on the requested weekday', () => {
      // Monday 15 June 2026.
      const after = new Date('2026-06-15T11:00:00Z');
      const next = nextRunFor({
        cadence: 'weekly',
        sendAtMinute: EIGHT_PM,
        timezone: 'Australia/Melbourne',
        sendOnWeekday: 6, // Saturday
        after,
      });

      expect(localPartsIn(next, 'Australia/Melbourne').weekday).toBe(6);
      expect(wallClock(next, 'Australia/Melbourne')).toBe('2026-06-20 20:00');
    });

    it('rolls to next week when today is the day but the hour has passed', () => {
      // Saturday 20 June 2026, 9 PM Melbourne.
      const after = new Date('2026-06-20T11:00:00Z');
      const next = nextRunFor({
        cadence: 'weekly',
        sendAtMinute: EIGHT_PM,
        timezone: 'Australia/Melbourne',
        sendOnWeekday: 6,
        after,
      });

      expect(wallClock(next, 'Australia/Melbourne')).toBe('2026-06-27 20:00');
    });

    it('refuses a weekly schedule with no weekday rather than guessing one', () => {
      expect(() =>
        nextRunFor({
          cadence: 'weekly',
          sendAtMinute: EIGHT_PM,
          timezone: 'Australia/Melbourne',
          after: new Date('2026-06-15T11:00:00Z'),
        }),
      ).toThrow(/sendOnWeekday/);
    });
  });

  it('refuses a minute outside the day', () => {
    for (const bad of [-1, 1440, 2.5]) {
      expect(() =>
        nextRunFor({
          cadence: 'daily',
          sendAtMinute: bad,
          timezone: 'Australia/Sydney',
          after: new Date('2026-06-15T11:00:00Z'),
        }),
      ).toThrow(RangeError);
    }
  });
});

describe('instantForLocalTime on the two impossible days', () => {
  /**
   * 2:30 AM does not exist on 4 October 2026 in Melbourne — the clock goes
   * straight from 2:00 to 3:00. There is no right answer, so the requirement
   * is only that it returns a real instant near the gap and does not loop,
   * throw, or silently land on the previous day.
   */
  it('resolves a time inside the spring-forward gap to a real instant', () => {
    const instant = instantForLocalTime(
      { year: 2026, month: 10, day: 4 },
      2 * 60 + 30,
      'Australia/Melbourne',
    );

    expect(Number.isFinite(instant.getTime())).toBe(true);
    const landed = localPartsIn(instant, 'Australia/Melbourne');
    expect(landed.day).toBe(4);
    // Lands at 3:30 AM AEDT — the gap skipped it forward by an hour.
    expect(landed.minuteOfDay).toBe(3 * 60 + 30);
  });

  /**
   * 2:30 AM happens twice on 5 April 2026. Picking the first means one email,
   * which is what "daily" promises.
   */
  it('picks the first of the two 2:30 AMs on the autumn-back day', () => {
    const instant = instantForLocalTime(
      { year: 2026, month: 4, day: 5 },
      2 * 60 + 30,
      'Australia/Melbourne',
    );

    // First pass is still AEDT (+11), so 2:30 local is 15:30Z the day before.
    expect(instant.toISOString()).toBe('2026-04-04T15:30:00.000Z');
    expect(localPartsIn(instant, 'Australia/Melbourne').minuteOfDay).toBe(2 * 60 + 30);
  });
});

describe('nextRunFor, interval cadence', () => {
  /**
   * An interval carries no wall clock, so none of the daylight-saving
   * machinery above applies to it. These tests exist to say that is
   * deliberate rather than forgotten.
   */
  it('adds elapsed time and nothing else', () => {
    const after = new Date('2026-06-15T10:00:00Z');
    const next = nextRunFor({
      cadence: 'interval',
      sendAtMinute: 0,
      timezone: 'Australia/Melbourne',
      intervalMinutes: 120,
      after,
    });

    expect(next.toISOString()).toBe('2026-06-15T12:00:00.000Z');
  });

  it('does not shift across a DST boundary, because it has no clock to shift', () => {
    // Spring forward in Melbourne is 4 Oct 2026. A daily 8 PM schedule moves
    // by an hour in UTC across it; a two-hourly one must not.
    const before = new Date('2026-10-03T15:00:00Z');
    const next = nextRunFor({
      cadence: 'interval',
      sendAtMinute: 0,
      timezone: 'Australia/Melbourne',
      intervalMinutes: 120,
      after: before,
    });

    expect(next.getTime() - before.getTime()).toBe(120 * 60 * 1000);
  });

  it('refuses an interval schedule with no interval', () => {
    expect(() =>
      nextRunFor({
        cadence: 'interval',
        sendAtMinute: 0,
        timezone: 'Australia/Sydney',
        after: new Date('2026-06-15T10:00:00Z'),
      }),
    ).toThrow(/intervalMinutes/);
  });

  it('ignores sendAtMinute entirely, rather than half-applying it', () => {
    const after = new Date('2026-06-15T10:00:00Z');
    const a = nextRunFor({
      cadence: 'interval', sendAtMinute: 0, timezone: 'Australia/Sydney',
      intervalMinutes: 180, after,
    });
    const b = nextRunFor({
      cadence: 'interval', sendAtMinute: 1200, timezone: 'Australia/Perth',
      intervalMinutes: 180, after,
    });

    expect(a.toISOString()).toBe(b.toISOString());
  });
});
