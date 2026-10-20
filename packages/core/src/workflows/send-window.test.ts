import { describe, expect, it } from 'vitest';
import { stepDueAt } from '../assistant/task-state';
import { nextInWindow, readWindow, windowFrom, type SendWindow } from './send-window';

/** ADR 0048: `wait_until` on the agency's clock — never the server's. */

const SYD = 'Australia/Sydney';
const officeHours: SendWindow = { from: 9 * 60, to: 17 * 60, days: [1, 2, 3, 4, 5], tz: SYD };
const nineAm: SendWindow = { from: 9 * 60, to: null, days: [0, 1, 2, 3, 4, 5, 6], tz: SYD };
const at = (iso: string) => new Date(iso);

describe('nextInWindow', () => {
  it('office hours: inside → at once; after → next working morning; Friday evening and Saturday → Monday', () => {
    // Tue 20 Oct 2026, 10:00 AEDT (+11)
    expect(nextInWindow(at('2026-10-19T23:00:00Z'), officeHours)).toEqual(at('2026-10-19T23:00:00Z'));
    // Tue 18:00 → Wed 09:00
    expect(nextInWindow(at('2026-10-20T07:00:00Z'), officeHours)).toEqual(at('2026-10-20T22:00:00Z'));
    // Tue 07:00 → Tue 09:00
    expect(nextInWindow(at('2026-10-19T20:00:00Z'), officeHours)).toEqual(at('2026-10-19T22:00:00Z'));
    // Fri 23 Oct 17:00 exactly (the window is closed at its end) → Mon 26 Oct 09:00
    expect(nextInWindow(at('2026-10-23T06:00:00Z'), officeHours)).toEqual(at('2026-10-25T22:00:00Z'));
    // Sat 24 Oct noon → Mon
    expect(nextInWindow(at('2026-10-24T01:00:00Z'), officeHours)).toEqual(at('2026-10-25T22:00:00Z'));
  });

  it('a time alone: the next one — today if still ahead, exactly now if now', () => {
    expect(nextInWindow(at('2026-10-19T21:00:00Z'), nineAm)).toEqual(at('2026-10-19T22:00:00Z')); // 08:00 → 09:00
    expect(nextInWindow(at('2026-10-19T22:00:00Z'), nineAm)).toEqual(at('2026-10-19T22:00:00Z')); // 09:00 → now
    expect(nextInWindow(at('2026-10-19T23:00:00Z'), nineAm)).toEqual(at('2026-10-20T22:00:00Z')); // 10:00 → tomorrow
  });

  it('across the daylight-saving change, 9 am stays 9 am on the wall clock', () => {
    // Sat 3 Oct 2026, 20:00 AEST (+10). Clocks go forward at 2 am on Sun 4 Oct.
    expect(nextInWindow(at('2026-10-03T10:00:00Z'), nineAm)).toEqual(at('2026-10-03T22:00:00Z')); // Sun 09:00 AEDT
  });

  it('the zone is the agency’s: the same instant is a different hour in Perth', () => {
    const perth: SendWindow = { ...officeHours, tz: 'Australia/Perth' };
    // 23:00Z Mon 19 Oct = Tue 10:00 Sydney (inside) but Tue 07:00 Perth (before) → 09:00 Perth = 01:00Z
    expect(nextInWindow(at('2026-10-19T23:00:00Z'), perth)).toEqual(at('2026-10-20T01:00:00Z'));
  });
});

describe('stepDueAt with a window', () => {
  it('the wait first, then the window', () => {
    // Tue 16:00 Sydney + 2 h = 18:00 → Wed 09:00
    expect(stepDueAt(null, 2, at('2026-10-20T05:00:00Z'), officeHours)).toEqual(at('2026-10-20T22:00:00Z'));
    expect(stepDueAt(null, 0, at('2026-10-19T23:00:00Z'), officeHours)).toEqual(at('2026-10-19T23:00:00Z'));
    expect(stepDueAt(null, 0, at('2026-10-19T23:00:00Z'))).toEqual(at('2026-10-19T23:00:00Z'));
  });
});

describe('windowFrom / readWindow', () => {
  it('days default to every day; what is stored reads back; anything else is no window', () => {
    const w = windowFrom({ type: 'wait_until', from: '09:30' }, SYD);
    expect(w).toEqual({ from: 570, to: null, days: [0, 1, 2, 3, 4, 5, 6], tz: SYD });
    expect(readWindow(JSON.parse(JSON.stringify(w)))).toEqual(w);
    expect(readWindow({ ...w, tz: 'Mars/Olympus' })).toBeNull();
    expect(readWindow({ ...w, days: [] })).toBeNull();
    expect(readWindow({ ...w, from: 1440 })).toBeNull();
    expect(readWindow(undefined)).toBeNull();
  });
});
