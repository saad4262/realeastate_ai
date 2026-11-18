import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reminderStillUseful } from '../appointments/reminders';
import { AI_REASON_WORDS, callbackTooLate } from './voice';

/** PLATFORM-PLAN 3.9: what late work does, by rule — a reminder only while useful, an AI call-back not hours late. */
const START = new Date('2026-11-20T10:00:00Z');
const at = (minutesBeforeStart: number) => new Date(START.getTime() - minutesBeforeStart * 60_000);

describe('reminderStillUseful', () => {
  it('15 minutes: from 15 to 7½ minutes before, not after', () => {
    expect(reminderStillUseful(START, 15, at(16))).toBe(false);
    expect(reminderStillUseful(START, 15, at(15))).toBe(true);
    expect(reminderStillUseful(START, 15, at(7.5))).toBe(true);
    expect(reminderStillUseful(START, 15, at(5))).toBe(false);
    expect(reminderStillUseful(START, 15, at(-1))).toBe(false);
  });
  it('an hour: until 30 minutes before; a day: until 12 hours before (30 minutes late after a short outage still goes)', () => {
    expect(reminderStillUseful(START, 60, at(30))).toBe(true);
    expect(reminderStillUseful(START, 60, at(29))).toBe(false);
    expect(reminderStillUseful(START, 1440, at(1440 - 30))).toBe(true);
    expect(reminderStillUseful(START, 1440, at(11 * 60))).toBe(false);
  });
  it('the due query applies the same window', () => {
    const src = readFileSync(join(__dirname, '..', 'appointments', 'reminders.ts'), 'utf8');
    expect(src).toContain('make_interval(secs => ${appointment.reminderMinutes} * 30)');
  });
});

describe('callbackTooLate', () => {
  const now = new Date('2026-11-20T09:00:00Z');
  it('due 2 hours ago or less: placed; more: not', () => {
    expect(callbackTooLate(new Date(now.getTime() - 2 * 3_600_000), now)).toBe(false);
    expect(callbackTooLate(new Date(now.getTime() - 2 * 3_600_000 - 1), now)).toBe(true);
    expect(callbackTooLate(null, now)).toBe(false);
  });
  it('the reason the agent sees says what to do', () => {
    expect(AI_REASON_WORDS.too_late).toMatch(/call them yourself/);
  });
  it('the tick checks lateness before anything else is decided or placed', () => {
    const src = readFileSync(join(__dirname, 'ai-callback.ts'), 'utf8');
    const loop = src.slice(src.indexOf('for (const c of claimed) {'));
    expect(loop.indexOf("await skip('too_late')")).toBeGreaterThan(-1);
    expect(loop.indexOf("await skip('too_late')")).toBeLessThan(loop.indexOf("await skip('not_ready')"));
  });
});
