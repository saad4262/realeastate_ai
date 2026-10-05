import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatInZone,
  instantToLocalInput,
  isValidTimeZone,
  localDateTimeToInstant,
  localInputToInstant,
} from './local-input';

/**
 * The server runs in UTC on Vercel. These tests pin the process there too,
 * so a conversion that quietly used the machine's clock would fail here
 * instead of on an agent's calendar (the 2026-10-05 bug).
 */
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = originalTz;
});

describe('wall clock ⇄ instant, in a named zone', () => {
  it("reads 9 AM in Melbourne as 9 AM in Melbourne, whatever the server's clock", () => {
    // AEDT (+11) on 14 Oct 2026.
    expect(localInputToInstant('2026-10-14T09:00', 'Australia/Melbourne')?.toISOString()).toBe('2026-10-13T22:00:00.000Z');
    // AEST (+10) in July.
    expect(localInputToInstant('2026-07-14T09:00', 'Australia/Melbourne')?.toISOString()).toBe('2026-07-13T23:00:00.000Z');
    // Brisbane has no daylight saving.
    expect(localInputToInstant('2026-10-14T09:00', 'Australia/Brisbane')?.toISOString()).toBe('2026-10-13T23:00:00.000Z');
  });

  it('round-trips: what was typed is what the box shows again', () => {
    for (const tz of ['Australia/Melbourne', 'Australia/Perth', 'Asia/Karachi', 'UTC']) {
      const instant = localInputToInstant('2026-12-01T14:30', tz)!;
      expect(instantToLocalInput(instant, tz)).toBe('2026-12-01T14:30');
    }
  });

  it('shows one instant as each viewer’s own clock', () => {
    const instant = new Date('2026-10-13T22:00:00.000Z');
    expect(instantToLocalInput(instant, 'Australia/Melbourne')).toBe('2026-10-14T09:00');
    expect(instantToLocalInput(instant, 'Australia/Perth')).toBe('2026-10-14T06:00');
    expect(instantToLocalInput(instant, 'Asia/Karachi')).toBe('2026-10-14T03:00');
  });

  it('survives both daylight-saving changes in Sydney', () => {
    // Spring forward, 4 Oct 2026: 2:30 AM never happens — lands just after the gap.
    expect(localInputToInstant('2026-10-04T02:30', 'Australia/Sydney')?.toISOString()).toBe('2026-10-03T16:30:00.000Z');
    // Autumn back, 5 Apr 2026: 2:30 AM happens twice — the earlier one.
    expect(localInputToInstant('2026-04-05T02:30', 'Australia/Sydney')?.toISOString()).toBe('2026-04-04T15:30:00.000Z');
  });

  it('joins separate date and time inputs the same way', () => {
    expect(localDateTimeToInstant('2026-10-14', '09:00', 'Australia/Melbourne')?.toISOString()).toBe('2026-10-13T22:00:00.000Z');
  });

  it('refuses nonsense rather than guessing', () => {
    expect(localInputToInstant('2026-13-01T09:00', 'Australia/Melbourne')).toBeNull();
    expect(localInputToInstant('tomorrow', 'Australia/Melbourne')).toBeNull();
    expect(localInputToInstant('2026-10-14T09:00', 'Mars/Olympus')).toBeNull();
    expect(isValidTimeZone('Australia/Melbourne')).toBe(true);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('prints an email time in the booked zone, named', () => {
    const text = formatInZone(new Date('2026-10-13T22:00:00.000Z'), 'Australia/Melbourne');
    expect(text).toMatch(/14 Oct 2026/);
    expect(text).toMatch(/9:00/);
    expect(text).toMatch(/AEDT|GMT\+11/);
  });
});
