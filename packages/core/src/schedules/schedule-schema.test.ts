import {
  auTimezoneEnum,
  deliveryStatusEnum,
  scheduleCadenceEnum,
  scheduleStatusEnum,
} from '@repo/db';
import { describe, expect, it } from 'vitest';
import {
  AU_TIMEZONES,
  createScheduleSchema,
  DELIVERY_STATUSES,
  savedSearchQuerySchema,
  SCHEDULE_CADENCES,
  SCHEDULE_STATUSES,
  sendAtLabel,
  updateScheduleSchema,
} from './schedule-schema';

/**
 * The vocabularies are written twice — once as a pgEnum and once as a zod
 * enum — and these tests are the reason that is allowed.
 *
 * Deriving the zod schemas from the drizzle enums would be one list instead of
 * two, but it would mean this module imports `@repo/db`, and `@repo/db` pulls
 * in postgres.js. This file is a FORM CONTRACT: a client component imports it
 * to validate before submitting. That import has already broken a build once
 * here, with `Can't resolve 'fs'`.
 *
 * So the duplication is deliberate and the drift is what is guarded. It is the
 * same trade `listing-schema.ts` makes — every enum there carries a "Mirrors
 * <name> in packages/db/schema.ts" comment — and this is the test that makes
 * the comment true. A test file may import `@repo/db` freely; it never ships.
 */
describe('the zod vocabularies match the database enums', () => {
  it('cadence', () => {
    expect([...SCHEDULE_CADENCES]).toEqual([...scheduleCadenceEnum.enumValues]);
  });

  it('status', () => {
    expect([...SCHEDULE_STATUSES]).toEqual([...scheduleStatusEnum.enumValues]);
  });

  it('delivery status', () => {
    expect([...DELIVERY_STATUSES]).toEqual([...deliveryStatusEnum.enumValues]);
  });

  it('timezones', () => {
    expect([...AU_TIMEZONES]).toEqual([...auTimezoneEnum.enumValues]);
  });
});

describe('savedSearchQuerySchema', () => {
  it('parses a query the chat would produce', () => {
    const parsed = savedSearchQuerySchema.safeParse({
      channel: 'rent',
      suburb: 'Pakenham',
      state: 'VIC',
      radiusKm: 30,
    });

    expect(parsed.success).toBe(true);
  });

  /**
   * The point of `.strict()`. A saved search whose filter was renamed must
   * fail loudly at the one moment somebody can still fix it, rather than
   * quietly searching without that filter and emailing the wrong homes.
   */
  it('refuses a key it does not know instead of dropping it', () => {
    const parsed = savedSearchQuerySchema.safeParse({
      channel: 'rent',
      suburb: 'Pakenham',
      petFriendly: true,
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses paging, which belongs to the caller and not to a saved search', () => {
    expect(savedSearchQuerySchema.safeParse({ channel: 'rent', limit: 10 }).success).toBe(false);
    expect(savedSearchQuerySchema.safeParse({ channel: 'rent', offset: 20 }).success).toBe(false);
  });

  it('refuses a property type outside the controlled vocabulary', () => {
    expect(savedSearchQuerySchema.safeParse({ propertyType: '2jkads' }).success).toBe(false);
    expect(savedSearchQuerySchema.safeParse({ propertyType: 'House' }).success).toBe(true);
  });
});

describe('createScheduleSchema', () => {
  const base = {
    searchPath: '/search?channel=rent&suburb=Pakenham&radius=30',
    prompt: 'houses to rent in Pakenham under 30km',
    name: 'Pakenham rentals',
    cadence: 'daily' as const,
    sendAtMinute: 1200,
    timezone: 'Australia/Melbourne' as const,
  };

  it('accepts a daily schedule', () => {
    expect(createScheduleSchema.safeParse(base).success).toBe(true);
  });

  /**
   * ARCHITECTURE § 9. A client that can hand over the filters can hand over
   * filters the person never saw, and the email that follows goes out in
   * their name. The browser names the search PAGE; the server decides what
   * that page means.
   */
  it('refuses a filter object supplied by the browser', () => {
    const parsed = createScheduleSchema.safeParse({
      ...base,
      query: { channel: 'rent', suburb: 'Toorak' },
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a search path that is not a search path', () => {
    for (const bad of ['https://evil.example/search?x=1', '//evil.example', '/listing/123', '']) {
      expect(createScheduleSchema.safeParse({ ...base, searchPath: bad }).success).toBe(false);
    }
  });

  it('refuses a weekly schedule with no weekday, and says which field', () => {
    const parsed = createScheduleSchema.safeParse({ ...base, cadence: 'weekly' });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['sendOnWeekday']);
    }
  });

  it('refuses a weekday on a daily schedule', () => {
    expect(createScheduleSchema.safeParse({ ...base, sendOnWeekday: 3 }).success).toBe(false);
  });

  it('accepts a weekly schedule that names its day', () => {
    const parsed = createScheduleSchema.safeParse({
      ...base,
      cadence: 'weekly',
      sendOnWeekday: 6,
    });

    expect(parsed.success).toBe(true);
  });

  it('refuses a minute outside the day', () => {
    expect(createScheduleSchema.safeParse({ ...base, sendAtMinute: 1440 }).success).toBe(false);
    expect(createScheduleSchema.safeParse({ ...base, sendAtMinute: -1 }).success).toBe(false);
  });

  it('refuses a timezone outside Australia', () => {
    expect(
      createScheduleSchema.safeParse({ ...base, timezone: 'America/New_York' }).success,
    ).toBe(false);
  });
});

describe('updateScheduleSchema', () => {
  it('does not let a person set their own schedule to failing', () => {
    expect(updateScheduleSchema.safeParse({ status: 'failing' }).success).toBe(false);
    expect(updateScheduleSchema.safeParse({ status: 'paused' }).success).toBe(true);
  });

  it('does not accept a new prompt — that is a re-resolve, not a field edit', () => {
    expect(updateScheduleSchema.safeParse({ prompt: 'something else' }).success).toBe(false);
  });

  /** Absent means "leave it"; null means "clear it". They differ on weekly → daily. */
  it('distinguishes clearing the weekday from leaving it alone', () => {
    expect(updateScheduleSchema.parse({})).not.toHaveProperty('sendOnWeekday');
    expect(updateScheduleSchema.parse({ sendOnWeekday: null }).sendOnWeekday).toBeNull();
  });
});

describe('sendAtLabel', () => {
  it('reads as a clock, including both awkward ends of the day', () => {
    expect(sendAtLabel(1200)).toBe('8:00 PM');
    expect(sendAtLabel(0)).toBe('12:00 AM');
    expect(sendAtLabel(720)).toBe('12:00 PM');
    expect(sendAtLabel(1439)).toBe('11:59 PM');
    expect(sendAtLabel(545)).toBe('9:05 AM');
  });
});
