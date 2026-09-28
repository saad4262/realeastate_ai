import { describe, expect, it } from 'vitest';
import {
  clockInputSchema,
  intervalInputSchema,
  intervalMinutesFrom,
  minutesFrom12Hour,
  to12Hour,
} from './time-input';

describe('minutesFrom12Hour', () => {
  it('reads an ordinary afternoon time', () => {
    expect(minutesFrom12Hour({ hour12: 4, minute: 15, meridiem: 'PM' })).toBe(16 * 60 + 15);
  });

  it('reads an ordinary morning time', () => {
    expect(minutesFrom12Hour({ hour12: 7, minute: 5, meridiem: 'AM' })).toBe(7 * 60 + 5);
  });

  /**
   * The two that `hour12 + 12` gets wrong, in both directions. A daily alert
   * set for midnight firing at noon is the bug this pins.
   */
  it('puts 12 AM at midnight, not at noon', () => {
    expect(minutesFrom12Hour({ hour12: 12, minute: 0, meridiem: 'AM' })).toBe(0);
  });

  it('puts 12 PM at noon, not at midnight and not off the end of the day', () => {
    expect(minutesFrom12Hour({ hour12: 12, minute: 0, meridiem: 'PM' })).toBe(720);
  });

  it('never produces a minute outside the day', () => {
    for (let hour = 1; hour <= 12; hour += 1) {
      for (const meridiem of ['AM', 'PM'] as const) {
        const value = minutesFrom12Hour({ hour12: hour, minute: 59, meridiem });
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1439);
      }
    }
  });

  it('refuses a 24-hour hour, rather than folding it', () => {
    expect(() => minutesFrom12Hour({ hour12: 16, minute: 15, meridiem: 'PM' })).toThrow();
  });

  it('round-trips every minute of the day', () => {
    for (let minute = 0; minute < 1440; minute += 1) {
      expect(minutesFrom12Hour(to12Hour(minute))).toBe(minute);
    }
  });
});

describe('intervalMinutesFrom', () => {
  it('converts each unit', () => {
    expect(intervalMinutesFrom(10, 'minutes')).toBe(10);
    expect(intervalMinutesFrom(2, 'hours')).toBe(120);
    expect(intervalMinutesFrom(3, 'days')).toBe(4320);
    expect(intervalMinutesFrom(2, 'weeks')).toBe(20160);
  });

  /** No ceiling: a schedule may be as far apart as somebody wants. */
  it('does not cap a long gap', () => {
    expect(intervalMinutesFrom(52, 'weeks')).toBe(52 * 7 * 24 * 60);
  });
});

describe('the form shapes', () => {
  it('takes the strings a form actually sends', () => {
    const parsed = clockInputSchema.parse({ hour12: '4', minute: '15', meridiem: 'PM' });
    expect(minutesFrom12Hour(parsed)).toBe(975);
  });

  /**
   * An unfilled select sends `''`. `Number('')` is 0 — a valid minute and a
   * valid-looking hour — so coercion has to reject it rather than accept a
   * time nobody chose.
   */
  it('rejects an empty field instead of reading it as zero', () => {
    expect(clockInputSchema.safeParse({ hour12: '', minute: '0', meridiem: 'AM' }).success).toBe(
      false,
    );
    expect(intervalInputSchema.safeParse({ every: '', unit: 'hours' }).success).toBe(false);
  });

  it('rejects a unit it does not know', () => {
    expect(intervalInputSchema.safeParse({ every: '2', unit: 'fortnights' }).success).toBe(false);
  });
});
