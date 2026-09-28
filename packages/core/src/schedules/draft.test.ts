import { describe, expect, it } from 'vitest';
import {
  describeCadence,
  describeDraft,
  signScheduleDraft,
  verifyScheduleDraft,
  type ScheduleDraft,
} from './draft';

const SECRET = 'draft-test-secret';

const draft: ScheduleDraft = {
  searchPath: '/search?channel=rent&suburb=Pakenham&radius=30&beds=3',
  cadence: 'daily',
  sendAtMinute: 1200,
  timezone: 'Australia/Melbourne',
};

/**
 * The signature is the only thing standing between a confirmation card and
 * a schedule somebody did not agree to. The card goes out to a browser, sits
 * there while they read it, and comes back — so every one of these is a way
 * that round trip could be abused.
 */
describe('schedule draft tokens', () => {
  it('round-trips', () => {
    const token = signScheduleDraft(draft, SECRET);
    expect(verifyScheduleDraft(token, SECRET)).toEqual({ ok: true, draft });
  });

  it('refuses a draft whose search was swapped', () => {
    const token = signScheduleDraft(draft, SECRET);
    const [, signature] = token.split('.');

    const tampered = { ...draft, searchPath: '/search?channel=sale&suburb=Toorak' };
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${signature}`;

    expect(verifyScheduleDraft(forged, SECRET).ok).toBe(false);
  });

  /**
   * The one that costs money. "Every hour" signed, "every minute" accepted
   * would be a mailing list and a model bill nobody asked for.
   */
  it('refuses a draft whose frequency was swapped', () => {
    const token = signScheduleDraft(draft, SECRET);
    const [, signature] = token.split('.');

    const tampered = { ...draft, cadence: 'interval' as const, intervalMinutes: 60 };
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${signature}`;

    expect(verifyScheduleDraft(forged, SECRET).ok).toBe(false);
  });

  it('refuses a token signed with a different secret', () => {
    expect(verifyScheduleDraft(signScheduleDraft(draft, 'other'), SECRET).ok).toBe(false);
  });

  it('refuses a validly signed payload that is not a draft', () => {
    // A signature over garbage is still a valid signature. The shape is
    // checked first so it cannot reach createSchedule as nonsense.
    const junk = { hello: 'world' };
    const payload = Buffer.from(JSON.stringify(junk)).toString('base64url');
    expect(verifyScheduleDraft(`${payload}.whatever`, SECRET).ok).toBe(false);
  });

  it('returns false rather than throwing on a malformed token', () => {
    for (const bad of ['', 'nodot', 'a.b', '...', 'x'.repeat(400)]) {
      expect(() => verifyScheduleDraft(bad, SECRET)).not.toThrow();
      expect(verifyScheduleDraft(bad, SECRET).ok).toBe(false);
    }
  });

  /**
   * `JSON.stringify` preserves insertion order, so a draft rebuilt with its
   * keys in a different order would sign differently — and Accept would
   * fail for a reason nobody could see. `canonical()` sorts them first.
   *
   * The token itself is NOT identical, because the readable payload is the
   * draft as given; only the signature is canonical. That is the half that
   * matters, and both halves are asserted here so the distinction is on the
   * record rather than a surprise to whoever reads the two tokens.
   */
  it('signs the same draft identically whatever order its keys are in', () => {
    const reordered = {
      timezone: draft.timezone,
      sendAtMinute: draft.sendAtMinute,
      cadence: draft.cadence,
      searchPath: draft.searchPath,
    } as ScheduleDraft;

    const signatureOf = (token: string) => token.split('.')[1];
    expect(signatureOf(signScheduleDraft(reordered, SECRET))).toBe(
      signatureOf(signScheduleDraft(draft, SECRET)),
    );

    // And the thing that actually has to work: either token verifies.
    expect(verifyScheduleDraft(signScheduleDraft(reordered, SECRET), SECRET)).toEqual({
      ok: true,
      draft: reordered,
    });
  });

  /** No user id inside, so signing in and coming back does not invalidate it. */
  it('binds the content and not a person', () => {
    const token = signScheduleDraft(draft, SECRET);
    const decoded = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));
    expect(Object.keys(decoded)).not.toContain('userId');
  });
});

describe('describeCadence', () => {
  it('reads as a person would say it', () => {
    expect(
      describeCadence({ cadence: 'daily', sendAtMinute: 1200, timezone: 'Australia/Melbourne' }),
    ).toBe('Every day at 8:00 PM, Melbourne time');

    expect(
      describeCadence({
        cadence: 'weekly',
        sendAtMinute: 540,
        sendOnWeekday: 6,
        timezone: 'Australia/Perth',
      }),
    ).toBe('Every Saturday at 9:00 AM, Perth time');
  });

  /** An interval has no clock in it, so the sentence must not imply one. */
  it('says nothing about a time or a zone for an interval', () => {
    const said = describeCadence({
      cadence: 'interval',
      sendAtMinute: 1200,
      intervalMinutes: 120,
      timezone: 'Australia/Melbourne',
    });

    expect(said).toBe('Every 2 hours');
    expect(said).not.toMatch(/Melbourne|PM|AM/);
  });

  it('reads an hour in the singular', () => {
    expect(
      describeCadence({
        cadence: 'interval',
        sendAtMinute: 0,
        intervalMinutes: 60,
        timezone: 'Australia/Sydney',
      }),
    ).toBe('Every hour');
  });

  /**
   * The bug this pins was on screen.
   *
   * `/alerts` had its own cadence formatter, a copy of this one that knew
   * `weekly` and treated everything else as daily. An interval schedule
   * carries `sendAtMinute: 0` because an interval has no clock, so a card
   * for a schedule running every hour read **"Every day at 12:00 AM"** —
   * confidently, and wrong about both halves. The page imports this now;
   * these cases are what "this" has to be right about.
   */
  it.each([
    [10, 'Every 10 minutes'],
    [45, 'Every 45 minutes'],
    [60, 'Every hour'],
    [120, 'Every 2 hours'],
    [24 * 60, 'Every 24 hours'],
    [3 * 24 * 60, 'Every 3 days'],
    [7 * 24 * 60, 'Every week'],
    [14 * 24 * 60, 'Every 2 weeks'],
    [26 * 7 * 24 * 60, 'Every 26 weeks'],
    [90, 'Every 90 minutes'],
    [25 * 60, 'Every 25 hours'],
  ])('describes an interval of %i minutes without inventing a clock', (minutes, expected) => {
    const said = describeCadence({
      cadence: 'interval',
      // The value an interval row really holds, which is what broke the copy.
      sendAtMinute: 0,
      intervalMinutes: minutes,
      timezone: 'Australia/Sydney',
    });

    expect(said).toBe(expected);
    expect(said).not.toMatch(/12:00 AM|Every day/);
  });
});

describe('describeDraft', () => {
  /**
   * The card says what will be STORED, not what the model said.
   *
   * It is what somebody presses Accept on, so the search is re-derived from
   * the path that will actually be saved.
   */
  it('describes the search from the path, server-side', () => {
    const described = describeDraft(draft);

    expect(described.search).toBe('3+ bed homes to rent in Pakenham and within 30 km');
    expect(described.cadence).toBe('Every day at 8:00 PM, Melbourne time');
    expect(described.searchPath).toBe(draft.searchPath);
  });
});
