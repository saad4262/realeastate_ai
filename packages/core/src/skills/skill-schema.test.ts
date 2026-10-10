import { describe, expect, it } from 'vitest';
import { MIN_INTERVAL_MINUTES } from '../schedules/schedule-schema';
import { MIN_SKILL_INTERVAL_MINUTES, parseScheduleLine, scheduleFromInput, skillScheduleSchema } from './skill-schema';

/**
 * Skills and saved searches are claimed by the same 5-minute tick and catch up
 * one slot per tick, so they share one floor: every 10 minutes.
 */
describe('skill interval schedules', () => {
  it('shares the saved-search floor', () => {
    expect(MIN_SKILL_INTERVAL_MINUTES).toBe(MIN_INTERVAL_MINUTES);
  });

  it('accepts minutes and hours in Markdown, down to the floor', () => {
    expect(parseScheduleLine('every 10m')).toEqual({ cadence: 'interval', intervalMinutes: 10, sendAtMinute: 0 });
    expect(parseScheduleLine('every 30 min')).toEqual({ cadence: 'interval', intervalMinutes: 30, sendAtMinute: 0 });
    expect(parseScheduleLine('every 2h')).toEqual({ cadence: 'interval', intervalMinutes: 120, sendAtMinute: 0 });
    expect(parseScheduleLine('every 24h')).toEqual({ cadence: 'interval', intervalMinutes: 1440, sendAtMinute: 0 });
  });

  it('refuses anything shorter than 10 minutes or longer than a day', () => {
    expect(parseScheduleLine('every 9m')).toBeNull();
    expect(parseScheduleLine('every 0h')).toBeNull();
    expect(parseScheduleLine('every 25h')).toBeNull();
    const base = { cadence: 'interval', time: '07:00', timezone: 'Australia/Sydney' } as const;
    expect(skillScheduleSchema.safeParse({ ...base, intervalMinutes: 9 }).success).toBe(false);
    expect(skillScheduleSchema.safeParse({ ...base, intervalMinutes: 1441 }).success).toBe(false);
    expect(skillScheduleSchema.safeParse({ ...base }).success).toBe(false);
  });

  it('stores the form value as minutes', () => {
    const v = skillScheduleSchema.parse({ cadence: 'interval', time: '07:00', timezone: 'Australia/Sydney', intervalMinutes: 15 });
    expect(scheduleFromInput(v).intervalMinutes).toBe(15);
  });
});
