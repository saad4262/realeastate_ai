import { describe, expect, it } from 'vitest';
import { startOfDayIn, startOfMonthIn, startOfWeekIn, startOfYearIn } from './local-input';

describe('local period starts (dashboard ranges)', () => {
  // Thu 8 Oct 2026, 10:30 in Sydney (AEDT, UTC+11) = Wed 7 Oct 23:30 UTC. DST began Sun 4 Oct.
  const now = new Date('2026-10-07T23:30:00Z');
  const tz = 'Australia/Sydney';
  it('today starts at local midnight, not UTC midnight', () => {
    expect(startOfDayIn(now, tz).toISOString()).toBe('2026-10-07T13:00:00.000Z');
    expect(startOfDayIn(now, tz, 1).toISOString()).toBe('2026-10-08T13:00:00.000Z');
  });
  it('the week starts on Monday in the agency zone', () => {
    expect(startOfWeekIn(now, tz).toISOString()).toBe('2026-10-04T13:00:00.000Z'); // Mon 5 Oct 00:00 AEDT
    expect(startOfWeekIn(now, tz, 1).toISOString()).toBe('2026-10-11T13:00:00.000Z');
  });
  it('a Monday morning is still the same week; a Sunday night is the week before', () => {
    // Mon 5 Oct 00:30 AEDT → that Monday; Sun 4 Oct 23:30 AEDT → Mon 28 Sep 00:00 AEST (before DST).
    expect(startOfWeekIn(new Date('2026-10-04T13:30:00Z'), tz).toISOString()).toBe('2026-10-04T13:00:00.000Z');
    expect(startOfWeekIn(new Date('2026-10-04T12:30:00Z'), tz).toISOString()).toBe('2026-09-27T14:00:00.000Z');
  });
  it('months and years roll over correctly, across the DST change', () => {
    expect(startOfMonthIn(now, tz).toISOString()).toBe('2026-09-30T14:00:00.000Z'); // 1 Oct 00:00 AEST (DST starts 4 Oct)
    expect(startOfMonthIn(now, tz, -1).toISOString()).toBe('2026-08-31T14:00:00.000Z');
    expect(startOfMonthIn(now, tz, 3).toISOString()).toBe('2026-12-31T13:00:00.000Z');
    expect(startOfYearIn(now, tz).toISOString()).toBe('2025-12-31T13:00:00.000Z');
    expect(startOfDayIn(now, 'Australia/Perth').toISOString()).toBe('2026-10-07T16:00:00.000Z');
  });
});
