import { and, count, eq, gt, inArray, sql } from 'drizzle-orm';
import { agency, missedCallSetting, phoneNumber, smsMessage, type DbOrTx } from '@repo/db';
import { isAuMobile, toAuE164 } from './format';
import { nextCallableTime } from './voice';

/**
 * The five SMS rules (ADR 0074 part 2, the user's answers 2026-11-02), in one place: Bulk SMS, matched buyers,
 * the workflow step and the missed-call text all ask these, at Prepare and again at the moment a text goes.
 * Pure helpers first; the few database reads after them.
 */

/** Rule 3: marketing and workflow texts go only in these hours, [from, to) on the agency's clock, every day. */
export type SmsHours = [number, number];
export const DEFAULT_SMS_HOURS: SmsHours = [9, 20];
/** Rule 4: automatic texts (missed call + workflow) to one number in 24 hours, across the agency's numbers. */
export const DEFAULT_AUTO_TEXTS_PER_CALLER_DAY = 3;
/** Rule 5: texts of every kind from one number in 24 hours. */
export const DEFAULT_TEXTS_PER_NUMBER_DAY = 100;

/** `sms_message.kind` of each automatic text — the ones rule 4 counts. */
export const AUTO_TEXT_KINDS = ['missed_call_text', 'workflow_sms'] as const;
/** `sms_message.kind` of the texts a person sent in a batch (Bulk SMS, matched buyers). */
export const BULK_TEXT_KIND = 'bulk_sms';

/** A stored value, checked; anything odd is the default. */
export function readSmsHours(v: unknown): SmsHours {
  if (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n)) && v[0] >= 0 && v[1] <= 24 && v[0] < v[1]) return [v[0], v[1]];
  return DEFAULT_SMS_HOURS;
}

/** The first instant at or after `t` inside the sending hours (`t` itself when inside them). */
export function nextSmsTime(t: Date, hours: SmsHours, timeZone: string): Date {
  return nextCallableTime(t, { weekdays: hours, saturday: hours, sunday: hours }, timeZone) ?? t;
}

export function inSmsHours(t: Date, hours: SmsHours, timeZone: string): boolean {
  return nextSmsTime(t, hours, timeZone).getTime() === t.getTime();
}

/** Why one person does not get a marketing or workflow text. Every one is shown before Approve. */
export const SMS_SKIP_REASONS = [
  'archived',
  'opted_out',
  'sms_opted_out',
  'no_consent',
  'no_mobile',
  'no_number',
  'batch_limit',
  'phone_changed',
  'daily_limit',
  'auto_limit',
  'skill_off',
  'dev_allowlist',
] as const;
export type SmsSkipReason = (typeof SMS_SKIP_REASONS)[number];

export const SMS_SKIP_REASON_LABELS: Record<SmsSkipReason, string> = {
  archived: 'Archived',
  opted_out: 'Unsubscribed from marketing',
  sms_opted_out: 'Replied STOP',
  no_consent: 'No marketing consent — none recorded, no enquiry in the last 24 months, not a client',
  no_mobile: 'No Australian mobile number',
  no_number: 'No number to send from — their agent has no number and the agency number is not set',
  batch_limit: 'Over the per-batch limit',
  phone_changed: 'Their mobile number changed since Prepare',
  daily_limit: 'Daily texting limit reached for that number',
  auto_limit: 'Already sent the most automatic texts allowed today',
  skill_off: '“Workflow texts” is off in Skills for the agent whose number it goes from',
  dev_allowlist: 'Not on the development allowlist (SMS_DEV_ALLOWLIST) — nothing real is texted outside production',
};

/**
 * Outside production the database is the live one, so a real Twilio key would text real people: only the
 * mobiles on SMS_DEV_ALLOWLIST (comma-separated, 04… or +61…) get a text. The stub (PHONE_STUB=1) sends
 * nothing anywhere, so it needs no list. Null = no restriction.
 */
export function smsDevAllowlist(env: NodeJS.ProcessEnv = process.env): ((e164: string) => boolean) | null {
  if (env.NODE_ENV === 'production' || env.PHONE_STUB === '1') return null;
  const allowed = new Set(
    (env.SMS_DEV_ALLOWLIST ?? '')
      .split(',')
      .map((v) => toAuE164(v.trim()))
      .filter((v): v is string => Boolean(v)),
  );
  return (e164: string) => allowed.has(e164);
}

/**
 * Rule 2 (+ the number): the first reason this person may not get the text, or null. The email unsubscribe is
 * tested before consent (it wins over any consent, ADR 0043), STOP before everything a person could fix.
 * Consent is the Bulk email rule — recorded, an enquiry in 24 months, or a client — never weaker.
 */
export function smsSkipReason(c: {
  archived: boolean;
  optedOut: boolean;
  smsOptedOut: boolean;
  consent: boolean;
  mobile: string | null;
  hasFromNumber: boolean;
}): SmsSkipReason | null {
  if (c.archived) return 'archived';
  if (c.optedOut) return 'opted_out';
  if (c.smsOptedOut) return 'sms_opted_out';
  if (!c.consent) return 'no_consent';
  if (!c.mobile || !isAuMobile(c.mobile)) return 'no_mobile';
  if (!c.hasFromNumber) return 'no_number';
  return null;
}

/**
 * Rule 1, pure: the number a text goes from — the contact's agent's active number, else the agency number.
 * `numbers` maps a user id to their active number; `agencyNumberId` is the owner's pick (or their own).
 */
export function fromNumberFor(
  assignedTo: string | null,
  numbers: ReadonlyMap<string, { id: string; e164: string; userId: string }>,
  agencyNumber: { id: string; e164: string; userId: string } | null,
): { id: string; e164: string; userId: string } | null {
  return (assignedTo ? numbers.get(assignedTo) : undefined) ?? agencyNumber;
}

// ── Database reads ──────────────────────────────────────────────────────────

export type SmsRules = {
  hours: SmsHours;
  autoPerCaller: number;
  perNumber: number;
  timeZone: string;
  /** The agency's active numbers, by agent. */
  numbers: Map<string, { id: string; e164: string; userId: string }>;
  /** Rule 1's fallback: the owner's pick if it is still active, else an owner's own number; null when none. */
  agencyNumber: { id: string; e164: string; userId: string } | null;
};

/** Everything the rules need about one agency, in three reads. */
export async function loadSmsRules(db: DbOrTx, agencyId: string): Promise<SmsRules> {
  const [[setting], [ag], nums] = await Promise.all([
    db
      .select({ agencyNumberId: missedCallSetting.agencyNumberId, smsHours: missedCallSetting.smsHours, auto: missedCallSetting.autoTextsPerCallerDay, perNumber: missedCallSetting.textsPerNumberDay })
      .from(missedCallSetting)
      .where(eq(missedCallSetting.agencyId, agencyId))
      .limit(1),
    db.select({ timeZone: agency.timeZone }).from(agency).where(eq(agency.id, agencyId)).limit(1),
    db.execute<{ id: string; e164: string; user_id: string; is_owner: boolean }>(sql`
      select pn.id, pn.e164, pn.user_id, (m.role = 'owner') as is_owner
      from phone_number pn
      left join membership m on m.user_id = pn.user_id and m.agency_id = pn.agency_id and m.status = 'active'
      where pn.agency_id = ${agencyId} and pn.status = 'active'
      order by pn.created_at`),
  ]);
  const numbers = new Map(nums.map((n) => [n.user_id, { id: n.id, e164: n.e164, userId: n.user_id }]));
  const picked = setting?.agencyNumberId ? nums.find((n) => n.id === setting.agencyNumberId) : undefined;
  const fallback = picked ?? nums.find((n) => n.is_owner === true || (n.is_owner as unknown) === 't');
  return {
    hours: readSmsHours(setting?.smsHours),
    autoPerCaller: setting?.auto ?? DEFAULT_AUTO_TEXTS_PER_CALLER_DAY,
    perNumber: setting?.perNumber ?? DEFAULT_TEXTS_PER_NUMBER_DAY,
    timeZone: ag?.timeZone ?? 'Australia/Sydney',
    numbers,
    agencyNumber: fallback ? { id: fallback.id, e164: fallback.e164, userId: fallback.user_id } : null,
  };
}

const DAY = sql`now() - interval '24 hours'`;

/** Rule 5: texts of every kind sent (or queued) from this number in the last 24 hours. */
export async function textsFromNumberToday(db: DbOrTx, phoneNumberId: string): Promise<number> {
  const [r] = await db.select({ n: count() }).from(smsMessage).where(and(eq(smsMessage.phoneNumberId, phoneNumberId), eq(smsMessage.direction, 'out'), gt(smsMessage.createdAt, DAY)));
  return r?.n ?? 0;
}

/** Rule 4: automatic texts (missed call + workflow) to this number from any of the agency's numbers in 24 hours. */
export async function autoTextsToCallerToday(db: DbOrTx, agencyId: string, e164: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(smsMessage)
    .where(and(eq(smsMessage.agencyId, agencyId), eq(smsMessage.counterpart, e164), eq(smsMessage.direction, 'out'), inArray(smsMessage.kind, [...AUTO_TEXT_KINDS]), gt(smsMessage.createdAt, DAY)));
  return r?.n ?? 0;
}

/** An active number of this agency, by id (the sending loop re-reads it: a released number sends nothing). */
export async function activeNumber(db: DbOrTx, agencyId: string, id: string): Promise<{ id: string; e164: string; userId: string } | null> {
  const [n] = await db
    .select({ id: phoneNumber.id, e164: phoneNumber.e164, userId: phoneNumber.userId })
    .from(phoneNumber)
    .where(and(eq(phoneNumber.id, id), eq(phoneNumber.agencyId, agencyId), eq(phoneNumber.status, 'active')))
    .limit(1);
  return n ?? null;
}
