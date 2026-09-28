import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { describeSavedQuery, parseSearchParams } from '../listings/search-url';
import {
  auTimezoneSchema,
  intervalMinutesSchema,
  scheduleCadenceSchema,
  sendAtLabel,
  sendAtMinuteSchema,
  sendOnWeekdaySchema,
  type ScheduleCadence,
} from './schedule-schema';
import { timezoneLabel } from './timezones';

/**
 * A schedule the guide has proposed and nobody has agreed to yet.
 *
 * ## Why this is signed rather than stored
 *
 * The confirmation card has to survive a round trip through the browser:
 * the model proposes, the person reads it, and some time later they press
 * Accept. Two ways to make that safe —
 *
 *  - write a `draft` row and have the card carry only its id, or
 *  - sign the draft and let the card carry the whole thing.
 *
 * The second is used here for two reasons. Nothing is written until the
 * person agrees, which is what was actually asked for; and a card that is
 * never accepted leaves nothing behind to garbage-collect. The HMAC is what
 * makes it safe: a browser can read the draft, and cannot change the search
 * or the frequency inside it without the signature failing.
 *
 * ## What the token does NOT carry
 *
 * No user id. The token authorises the *content* — this search, this
 * frequency — and the session decides *whose* it becomes at the moment it
 * is accepted. That is what lets an anonymous visitor be shown a card, sign
 * in, and accept it as themselves without the draft having to be reissued.
 */
export const scheduleDraftSchema = z
  .object({
    /** The `/search?…` this was proposed from. Parsed server-side on accept. */
    searchPath: z.string().min(1).max(2000),
    /** What the person said, for the schedule's name. */
    prompt: z.string().max(1000).optional(),
    cadence: scheduleCadenceSchema,
    sendAtMinute: sendAtMinuteSchema,
    sendOnWeekday: sendOnWeekdaySchema.optional(),
    intervalMinutes: intervalMinutesSchema.optional(),
    timezone: auTimezoneSchema,
  })
  .strict();

export type ScheduleDraft = z.infer<typeof scheduleDraftSchema>;

/**
 * Canonical JSON, so the same draft always signs to the same bytes.
 *
 * `JSON.stringify` preserves insertion order, and a draft rebuilt with its
 * keys in a different order would produce a different signature for an
 * identical schedule. Sorting the keys removes that as a source of
 * "sometimes the Accept button does not work".
 */
function canonical(draft: ScheduleDraft): string {
  const entries = Object.entries(draft)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(draft: ScheduleDraft, secret: string): string {
  return base64url(createHmac('sha256', secret).update(canonical(draft)).digest());
}

export function signScheduleDraft(draft: ScheduleDraft, secret: string): string {
  const payload = base64url(Buffer.from(JSON.stringify(draft), 'utf8'));
  return `${payload}.${sign(draft, secret)}`;
}

export type DraftClaim = { ok: true; draft: ScheduleDraft } | { ok: false };

export function verifyScheduleDraft(token: string, secret: string): DraftClaim {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false };
  const [payload, offered] = parts as [string, string];

  let parsed: unknown;
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    parsed = JSON.parse(json);
  } catch {
    return { ok: false };
  }

  // Shape first. A signature over something that is not a draft is still a
  // valid signature, and it would reach `createSchedule` as garbage.
  const draft = scheduleDraftSchema.safeParse(parsed);
  if (!draft.success) return { ok: false };

  const expected = sign(draft.data, secret);

  // timingSafeEqual throws on unequal lengths, which would turn a malformed
  // token into a 500 and leak the expected length through the difference.
  const a = Buffer.from(offered, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return { ok: false };
  if (!timingSafeEqual(a, b)) return { ok: false };

  return { ok: true, draft: draft.data };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * How often, in words, for the confirmation card and the schedule list.
 *
 * Written by the server from the structured draft, never by the model — the
 * card is what the person is agreeing to, so the sentence on it has to
 * describe what will actually be stored rather than what the model said.
 */
export function describeCadence(input: {
  cadence: ScheduleCadence;
  sendAtMinute: number;
  sendOnWeekday?: number | null;
  intervalMinutes?: number | null;
  timezone: string;
}): string {
  if (input.cadence === 'interval') {
    const minutes = input.intervalMinutes ?? 0;
    const DAY = 24 * 60;
    const WEEK = 7 * DAY;

    if (minutes % 60 !== 0) return `Every ${minutes} minutes`;

    /**
     * Said in the largest unit it divides into cleanly.
     *
     * Hours all the way up was fine while the ceiling was one week. With the
     * ceiling gone, a fortnight read "Every 336 hours" — arithmetically
     * right and not a sentence anybody would say, and it appears on the
     * confirmation card somebody is being asked to agree to.
     *
     * One day stays "Every 24 hours" rather than becoming "Every day",
     * because "Every day" is the `daily` cadence — a wall-clock time that
     * survives a DST change — and an interval is elapsed time that does
     * not. Two different things must not read the same.
     */
    if (minutes % WEEK === 0) {
      const weeks = minutes / WEEK;
      return weeks === 1 ? 'Every week' : `Every ${weeks} weeks`;
    }
    if (minutes % DAY === 0 && minutes > DAY) return `Every ${minutes / DAY} days`;

    const hours = minutes / 60;
    if (hours === 24) return 'Every 24 hours';
    return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
  }

  const time = sendAtLabel(input.sendAtMinute);
  const zone = timezoneLabel(input.timezone);

  if (input.cadence === 'weekly') {
    const day = WEEKDAYS[input.sendOnWeekday ?? 0] ?? 'Monday';
    return `Every ${day} at ${time}, ${zone} time`;
  }

  return `Every day at ${time}, ${zone} time`;
}

/** The whole card, in one place, so the chat and the accept path agree. */
export function describeDraft(draft: ScheduleDraft): {
  search: string;
  cadence: string;
  searchPath: string;
} {
  const queryString = draft.searchPath.includes('?') ? draft.searchPath.split('?')[1] : '';
  const query = parseSearchParams(new URLSearchParams(queryString ?? ''));

  return {
    // Server-authored from the filters that will actually be stored. If the
    // model described the search differently, this is the one that is true.
    search: describeSavedQuery(query),
    cadence: describeCadence(draft),
    searchPath: draft.searchPath,
  };
}

/** No default, ever — a default secret is a draft anybody can forge. */
export function requireDraftSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.ALERT_UNSUBSCRIBE_SECRET?.trim();
  if (!secret) {
    throw new Error('Scheduling is not configured: ALERT_UNSUBSCRIBE_SECRET not set');
  }
  return secret;
}
