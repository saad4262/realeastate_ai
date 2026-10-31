import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agency, missedCallSetting, notification, phoneCall, phoneNumber, smsMessage, user, type Db, type DbOrTx } from '@repo/db';
import { can, isAgencyAdminRole, type Actor, type MembershipRole } from '../permissions';
import { isPairedSkillOn } from '../skill-switches/switches';
import { displayAu, isAuMobile, webhookUrl, xmlEscape } from './format';
import { agencyTwilio, contactByPhone, PhoneError, providerFailure, textsPathFor, type PhoneDeps } from './setup';
import { isOptedOut } from './sms';
import { emitWorkflowEvent } from '../workflows/events';
import { AI_REASON_WORDS, decideAiCallback, DEFAULT_CALLING_HOURS, nextCallableTime, readCallingHours, type AiSkipReason, type CallingHours, type VoiceAi } from './voice';

/**
 * Missed calls (ADR 0071, Phase 3.2). A caller an agent did not answer is forwarded to the agent's
 * Twilio number: the platform keeps the call, the caller hears a greeting, and — only while the
 * "Missed call text" skill is on for the agency AND that agent (ADR 0069) — gets the agency's approved
 * text from the agent's number. Never more than once per caller a day, never to anyone who replied STOP,
 * never past the daily ceilings. The text is the owner's template with three fields filled; no model
 * writes it (non-negotiable 7).
 */

export const MERGE_FIELDS = ['first_name', 'agent_first_name', 'agency_name'] as const;
type MergeField = (typeof MERGE_FIELDS)[number];

export const DEFAULT_MISSED_CALL_SETTINGS: Omit<MissedCallSettings, 'updatedAt' | 'isDefault'> = {
  greeting: "Sorry, {{agent_first_name}} can't take your call right now. We'll text you straight away.",
  smsTemplate: "Hi {{first_name}}, {{agent_first_name}} from {{agency_name}} here. Sorry I missed your call! What can I help with? Reply here or I'll call you back shortly.",
  textsPerAgentDay: 50,
  textsPerAgencyDay: 300,
  aiCallAfterMinutes: 2,
  callingHours: DEFAULT_CALLING_HOURS,
  aiCallsPerAgentDay: 20,
  aiCallsPerAgencyDay: 100,
};

export const AI_CALL_AFTER_MINUTES = [1, 2, 5, 10] as const;

/** Heard when no text follows (the skill is off, a private number, STOP…): it promises nothing. */
export const NO_TEXT_GREETING = "Sorry, {{agent_first_name}} can't take your call right now. They'll get back to you soon.";

export type MissedCallSettings = {
  greeting: string;
  smsTemplate: string;
  textsPerAgentDay: number;
  textsPerAgencyDay: number;
  aiCallAfterMinutes: number;
  callingHours: CallingHours;
  aiCallsPerAgentDay: number;
  aiCallsPerAgencyDay: number;
  updatedAt: Date | null;
  isDefault: boolean;
};

/** Every `{{field}}` in a template that is not one we fill. */
export function unknownFields(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]!).filter((f) => !(MERGE_FIELDS as readonly string[]).includes(f));
}

export function renderMissedCallTemplate(template: string, values: Record<MergeField, string>): string {
  return template.replace(/\{\{\s*(first_name|agent_first_name|agency_name)\s*\}\}/g, (_, f: MergeField) => values[f]).replace(/\s+/g, ' ').trim();
}

/** The first word of a name, or the fallback. Never an email address. */
export function firstName(name: string | null | undefined, fallback: string): string {
  const w = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return w && !w.includes('@') ? w : fallback;
}

/** A day's AI calling hours: [from, to) in whole hours, or null for none. */
const hoursPair = z
  .tuple([z.coerce.number().int().min(0).max(23), z.coerce.number().int().min(1).max(24)])
  .refine(([a, b]) => a < b, 'Calling hours must end after they start.')
  .nullable();

const settingsSchema = z.object({
  greeting: z.string().trim().min(10, 'The greeting is too short.').max(300, 'Keep the greeting under 300 characters.'),
  smsTemplate: z.string().trim().min(10, 'The text is too short.').max(480, 'Keep the text under 480 characters (three texts).'),
  textsPerAgentDay: z.coerce.number().int().min(1).max(500),
  textsPerAgencyDay: z.coerce.number().int().min(1).max(5000),
  aiCallAfterMinutes: z.coerce.number().int().refine((n) => (AI_CALL_AFTER_MINUTES as readonly number[]).includes(n), 'Pick 1, 2, 5 or 10 minutes.').default(2),
  callingHours: z
    .object({ weekdays: hoursPair, saturday: hoursPair, sunday: hoursPair })
    .default(DEFAULT_CALLING_HOURS),
  aiCallsPerAgentDay: z.coerce.number().int().min(1).max(200).default(20),
  aiCallsPerAgencyDay: z.coerce.number().int().min(1).max(2000).default(100),
});
export type MissedCallSettingsInput = z.input<typeof settingsSchema>;

export async function loadMissedCallSettings(db: DbOrTx, agencyId: string): Promise<MissedCallSettings> {
  const [row] = await db.select().from(missedCallSetting).where(eq(missedCallSetting.agencyId, agencyId)).limit(1);
  return row
    ? {
        greeting: row.greeting,
        smsTemplate: row.smsTemplate,
        textsPerAgentDay: row.textsPerAgentDay,
        textsPerAgencyDay: row.textsPerAgencyDay,
        aiCallAfterMinutes: row.aiCallAfterMinutes,
        callingHours: readCallingHours(row.callingHours),
        aiCallsPerAgentDay: row.aiCallsPerAgentDay,
        aiCallsPerAgencyDay: row.aiCallsPerAgencyDay,
        updatedAt: row.updatedAt,
        isDefault: false,
      }
    : { ...DEFAULT_MISSED_CALL_SETTINGS, updatedAt: null, isDefault: true };
}

export async function getMissedCallSettings(db: DbOrTx, actor: Actor): Promise<MissedCallSettings & { canManage: boolean; agencyName: string }> {
  if (!actor.agencyId || !can(actor, 'phone:read', { type: 'phone', agencyId: actor.agencyId })) throw new PhoneError('forbidden', 'You do not have access to the missed-call settings.');
  const [ag] = await db.select({ name: agency.name }).from(agency).where(eq(agency.id, actor.agencyId)).limit(1);
  return { ...(await loadMissedCallSettings(db, actor.agencyId)), canManage: can(actor, 'phone:manage', { type: 'phone', agencyId: actor.agencyId }), agencyName: ag?.name ?? '' };
}

export async function saveMissedCallSettings(db: DbOrTx, actor: Actor, input: MissedCallSettingsInput): Promise<void> {
  if (!actor.agencyId || !can(actor, 'phone:manage', { type: 'phone', agencyId: actor.agencyId })) throw new PhoneError('forbidden', "Only the agency's owners and admins can change these.");
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw new PhoneError('invalid', parsed.error.issues[0]?.message ?? 'Check the values.');
  const bad = [...unknownFields(parsed.data.greeting), ...unknownFields(parsed.data.smsTemplate)];
  if (bad.length) throw new PhoneError('invalid', `Unknown field {{${bad[0]}}}. You can use {{first_name}}, {{agent_first_name}} and {{agency_name}}.`);
  const values = { ...parsed.data, updatedBy: actor.userId };
  await db
    .insert(missedCallSetting)
    .values({ agencyId: actor.agencyId, ...values })
    .onConflictDoUpdate({ target: missedCallSetting.agencyId, set: { ...values, updatedAt: sql`now()` } });
}

/**
 * For the settings page: is "Missed call text" on for the agency, and for how many of the agents who
 * have a number does it actually run (both switches, ADR 0069 §4).
 */
export async function missedCallSkillSummary(db: DbOrTx, actor: Actor): Promise<{ agencyOn: boolean; agentsOn: number; agentsWithNumber: number; offFor: string[] }> {
  if (!actor.agencyId || !can(actor, 'phone:read', { type: 'phone', agencyId: actor.agencyId })) throw new PhoneError('forbidden', 'You do not have access to the phone setup.');
  const people = await db.execute<{ user_id: string; name: string; role: MembershipRole; agency_on: boolean; mine_on: boolean }>(sql`
    select pn.user_id, coalesce(u.name, u.email) as name, m.role,
      exists (select 1 from skill_switch s where s.agency_id = pn.agency_id and s.user_id is null and s.skill_key = 'missed_call_text' and s.enabled) as agency_on,
      exists (select 1 from skill_switch s where s.agency_id = pn.agency_id and s.user_id = pn.user_id and s.skill_key = 'missed_call_text' and s.enabled) as mine_on
    from phone_number pn
    join "user" u on u.id = pn.user_id
    join membership m on m.user_id = pn.user_id and m.agency_id = pn.agency_id
    where pn.agency_id = ${actor.agencyId} and pn.status = 'active'
    order by 2`);
  const [agency] = await db.execute<{ on: boolean }>(sql`select exists (select 1 from skill_switch where agency_id = ${actor.agencyId} and user_id is null and skill_key = 'missed_call_text' and enabled) as on`);
  const runs = (p: (typeof people)[number]) => p.agency_on && (isAgencyAdminRole(p.role) || p.mine_on);
  return { agencyOn: Boolean(agency?.on), agentsOn: people.filter(runs).length, agentsWithNumber: people.length, offFor: people.filter((p) => !runs(p)).map((p) => p.name) };
}

// ── What to do about one missed call ────────────────────────────────────────

export type MissedCallOutcome = 'texted' | 'skill_off' | 'private' | 'not_mobile' | 'opted_out' | 'repeat' | 'limit' | 'text_failed';

export const OUTCOME_WORDS: Record<MissedCallOutcome, string> = {
  texted: 'Texted',
  skill_off: 'Not texted: Missed call text is off in Skills',
  private: 'Not texted: private number',
  not_mobile: 'Not texted: not a mobile',
  opted_out: 'Not texted: they replied STOP',
  repeat: 'Not texted: already texted today',
  limit: 'Not texted: daily limit reached',
  text_failed: 'The text failed',
};

/** Pure: whether this caller gets the text, or the first reason they don't. Order matters only for the words. */
export function decideMissedCallText(f: {
  skillOn: boolean;
  from: string | null;
  optedOut: boolean;
  textedToday: boolean;
  agentTextsToday: number;
  agencyTextsToday: number;
  limits: { perAgent: number; perAgency: number };
}): 'send' | Exclude<MissedCallOutcome, 'texted' | 'text_failed'> {
  if (!f.skillOn) return 'skill_off';
  if (!f.from) return 'private';
  if (!isAuMobile(f.from)) return 'not_mobile';
  if (f.optedOut) return 'opted_out';
  if (f.textedToday) return 'repeat';
  if (f.agentTextsToday >= f.limits.perAgent || f.agencyTextsToday >= f.limits.perAgency) return 'limit';
  return 'send';
}

type NumberRow = { id: string; agencyId: string; userId: string; e164: string; agentName: string; role: MembershipRole | null; retellRegisteredAt: Date | null };

/** AI calls that count against the daily ceilings and "once a day": placed or about to be. */
const AI_COUNTED = ['scheduled', 'calling', 'done', 'no_answer'];

/**
 * A missed call reached an agent's number (the voice webhook, after the token): keep it, decide the
 * text, tell the agent, and return the greeting (TwiML) the caller hears. The text is written queued in
 * the transaction and sent to Twilio after it (never inside).
 */
export async function recordMissedCall(db: Db, n: NumberRow, callSid: string, from: string | null, deps: PhoneDeps & { voice?: VoiceAi | null }): Promise<string> {
  const day = sql`now() - interval '24 hours'`;
  const settings = await loadMissedCallSettings(db, n.agencyId);
  const who = from ? await contactByPhone(db, n.agencyId, from) : null;
  const skillOn = await isPairedSkillOn(db, n.agencyId, n.userId, n.role, 'missed_call_text');
  let decision: ReturnType<typeof decideMissedCallText> = 'skill_off';
  if (skillOn) {
    const [[agentN], [agencyN], [repeat]] = await Promise.all([
      db.select({ n: count() }).from(smsMessage).where(and(eq(smsMessage.phoneNumberId, n.id), eq(smsMessage.kind, 'missed_call_text'), gt(smsMessage.createdAt, day))),
      db.select({ n: count() }).from(smsMessage).where(and(eq(smsMessage.agencyId, n.agencyId), eq(smsMessage.kind, 'missed_call_text'), gt(smsMessage.createdAt, day))),
      from
        ? db.select({ n: count() }).from(smsMessage).where(and(eq(smsMessage.phoneNumberId, n.id), eq(smsMessage.counterpart, from), eq(smsMessage.kind, 'missed_call_text'), gt(smsMessage.createdAt, day)))
        : Promise.resolve([{ n: 0 }]),
    ]);
    decision = decideMissedCallText({
      skillOn,
      from,
      optedOut: from ? await isOptedOut(db, n.agencyId, from) : false,
      textedToday: (repeat?.n ?? 0) > 0,
      agentTextsToday: agentN?.n ?? 0,
      agencyTextsToday: agencyN?.n ?? 0,
      limits: { perAgent: settings.textsPerAgentDay, perAgency: settings.textsPerAgencyDay },
    });
  }
  const [ag] = await db.select({ name: agency.name, timeZone: agency.timeZone }).from(agency).where(eq(agency.id, n.agencyId)).limit(1);
  const values = { first_name: firstName(who?.name, 'there'), agent_first_name: firstName(n.agentName, 'the agent'), agency_name: ag?.name ?? '' };
  const body = renderMissedCallTemplate(settings.smsTemplate, values);
  const smsId = decision === 'send' ? randomUUID() : null;

  // The AI call back (ADR 0072): only scheduled here, behind its own two-switch skill; the tick places it.
  let ai: { status: 'scheduled' | 'skipped'; reason: AiSkipReason | null; dueAt: Date | null } = { status: 'skipped', reason: 'skill_off', dueAt: null };
  if (await isPairedSkillOn(db, n.agencyId, n.userId, n.role, 'ai_callback')) {
    const [[agentCalls], [agencyCalls], [again]] = await Promise.all([
      db.select({ n: count() }).from(phoneCall).where(and(eq(phoneCall.phoneNumberId, n.id), inArray(phoneCall.aiStatus, AI_COUNTED), gt(phoneCall.createdAt, day))),
      db.select({ n: count() }).from(phoneCall).where(and(eq(phoneCall.agencyId, n.agencyId), inArray(phoneCall.aiStatus, AI_COUNTED), gt(phoneCall.createdAt, day))),
      from
        ? db.select({ n: count() }).from(phoneCall).where(and(eq(phoneCall.phoneNumberId, n.id), eq(phoneCall.fromE164, from), inArray(phoneCall.aiStatus, AI_COUNTED), gt(phoneCall.createdAt, day)))
        : Promise.resolve([{ n: 0 }]),
    ]);
    const choice = decideAiCallback({
      skillOn: true,
      ready: Boolean(n.retellRegisteredAt && deps.voice),
      from,
      optedOut: from ? await isOptedOut(db, n.agencyId, from) : false,
      calledToday: (again?.n ?? 0) > 0,
      agentCallsToday: agentCalls?.n ?? 0,
      agencyCallsToday: agencyCalls?.n ?? 0,
      limits: { perAgent: settings.aiCallsPerAgentDay, perAgency: settings.aiCallsPerAgencyDay },
    });
    if (choice === 'schedule') {
      const due = nextCallableTime(new Date(Date.now() + settings.aiCallAfterMinutes * 60_000), settings.callingHours, ag?.timeZone ?? 'Australia/Sydney');
      ai = due ? { status: 'scheduled', reason: null, dueAt: due } : { status: 'skipped', reason: 'no_hours', dueAt: null };
    } else {
      ai = { status: 'skipped', reason: choice, dueAt: null };
    }
  }
  const aiLine =
    ai.status === 'scheduled'
      ? ` The AI calls them back ${ai.dueAt!.toLocaleString('en-AU', { timeZone: ag?.timeZone ?? 'Australia/Sydney', weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`
      : ai.reason && ai.reason !== 'skill_off'
        ? ` No AI call back: ${AI_REASON_WORDS[ai.reason]}.`
        : '';

  const kept = await db.transaction(async (tx) => {
    if (smsId) {
      await tx.insert(smsMessage).values({ id: smsId, agencyId: n.agencyId, phoneNumberId: n.id, counterpart: from!, contactId: who?.id ?? null, direction: 'out', body, status: 'queued', kind: 'missed_call_text' });
    }
    const [row] = await tx
      .insert(phoneCall)
      .values({
        agencyId: n.agencyId,
        phoneNumberId: n.id,
        kind: 'missed',
        callSid,
        fromE164: from,
        contactId: who?.id ?? null,
        status: 'received',
        outcome: smsId ? 'texted' : decision,
        smsMessageId: smsId,
        aiStatus: ai.status,
        aiReason: ai.reason,
        aiDueAt: ai.dueAt,
      })
      .onConflictDoNothing({ target: phoneCall.callSid })
      .returning({ id: phoneCall.id });
    if (!row) throw new DuplicateCall(); // Twilio sent this call twice: roll the text back too
    // ADR 0074: the trigger "a call is missed", in the call's own transaction (the outbox, ADR 0041). Ids only.
    await emitWorkflowEvent(tx, {
      agencyId: n.agencyId,
      kind: 'call.missed',
      contactId: who?.id ?? null,
      origin: 'system',
      data: { agent: n.userId, caller: who ? 'known' : 'new', call: row.id },
    });
    const name = who?.name ?? (from ? displayAu(from) : 'a private number');
    await tx
      .insert(notification)
      .values({
        userId: n.userId,
        agencyId: n.agencyId,
        kind: 'missed_call',
        title: `Missed call from ${name}`.slice(0, 300),
        body: `${smsId ? `Texted them: “${body.slice(0, 200)}”` : OUTCOME_WORDS[decision as MissedCallOutcome]}.${aiLine}`.replace('”.', '”'),
        href: `${isAgencyAdminRole(n.role) ? '/missed-calls' : '/my-missed-calls'}?call=${row.id}`,
        dedupeKey: `call:${callSid}`,
      })
      .onConflictDoNothing();
    return row.id;
  }).catch((err: unknown) => {
    if (err instanceof DuplicateCall) return null;
    throw err;
  });

  if (kept && smsId && from) {
    try {
      const { client } = await agencyTwilio(db, n.agencyId, deps);
      const statusUrl = deps.keys && deps.webhookBase ? webhookUrl(deps.webhookBase, n.id, 'sms-status', deps.keys) : null;
      const r = await client.sendSms({ from: n.e164, to: from, body, statusUrl });
      await db.update(smsMessage).set({ status: r.status === 'sent' ? 'sent' : 'queued', providerSid: r.sid, updatedAt: sql`now()` }).where(eq(smsMessage.id, smsId));
    } catch (err) {
      const failure = providerFailure(err, 'Twilio refused the saved key.');
      await db.update(smsMessage).set({ status: 'failed', error: failure.message, updatedAt: sql`now()` }).where(eq(smsMessage.id, smsId));
      await db.update(phoneCall).set({ outcome: 'text_failed', updatedAt: sql`now()` }).where(eq(phoneCall.id, kept));
    }
  }

  const greeting = renderMissedCallTemplate(smsId ? settings.greeting : NO_TEXT_GREETING, values);
  return `<Say language="en-AU">${xmlEscape(greeting)}</Say><Hangup/>`;
}

class DuplicateCall extends Error {}

// ── The Missed calls page ───────────────────────────────────────────────────

export type MissedCallRow = {
  id: string;
  at: Date;
  from: string | null;
  display: string;
  contactId: string | null;
  contactName: string | null;
  agentName: string;
  phoneNumberId: string;
  outcome: MissedCallOutcome | null;
  textStatus: string | null;
  replied: boolean;
  handledAt: Date | null;
  /** ADR 0072: the AI call back — status, why it was skipped, Retell's label, when it is due. */
  aiStatus: string | null;
  aiReason: AiSkipReason | null;
  aiPriority: 'high' | 'medium' | 'low' | null;
  aiDueAt: Date | null;
};

export type MissedCallList = {
  rows: MissedCallRow[];
  counts: { missed: number; texted: number; replied: number; waiting: number };
  everyAgent: boolean;
};

/** This week's missed calls the person may see: an agent's own number; owners and admins every agent's. */
export async function listMissedCalls(db: DbOrTx, actor: Actor, opts: { days?: number; waitingOnly?: boolean } = {}): Promise<MissedCallList> {
  if (!actor.agencyId || !actor.membershipRole) throw new PhoneError('forbidden', 'You do not have access to missed calls.');
  const everyAgent = isAgencyAdminRole(actor.membershipRole) && can(actor, 'sms:read', { type: 'sms', agencyId: actor.agencyId });
  const since = new Date(Date.now() - (opts.days ?? 7) * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: phoneCall.id,
      at: phoneCall.createdAt,
      from: phoneCall.fromE164,
      contactId: phoneCall.contactId,
      contactName: sql<string | null>`(select c.name from contact c where c.id = phone_call.contact_id)`,
      agentName: sql<string>`coalesce(${user.name}, ${user.email})`,
      phoneNumberId: phoneCall.phoneNumberId,
      outcome: phoneCall.outcome,
      textStatus: sql<string | null>`(select s.status from sms_message s where s.id = phone_call.sms_message_id)`,
      replied: sql<boolean>`exists (select 1 from sms_message r where r.phone_number_id = phone_call.phone_number_id and r.counterpart = phone_call.from_e164 and r.direction = 'in' and r.created_at > phone_call.created_at)`,
      handledAt: phoneCall.handledAt,
      aiStatus: phoneCall.aiStatus,
      aiReason: phoneCall.aiReason,
      aiPriority: phoneCall.aiPriority,
      aiDueAt: phoneCall.aiDueAt,
    })
    .from(phoneCall)
    .innerJoin(phoneNumber, eq(phoneNumber.id, phoneCall.phoneNumberId))
    .innerJoin(user, eq(user.id, phoneNumber.userId))
    .where(
      and(
        eq(phoneCall.agencyId, actor.agencyId),
        eq(phoneCall.kind, 'missed'),
        gte(phoneCall.createdAt, since),
        ...(everyAgent ? [] : [eq(phoneNumber.userId, actor.userId)]),
        ...(opts.waitingOnly ? [isNull(phoneCall.handledAt)] : []),
      ),
    )
    .orderBy(desc(phoneCall.createdAt))
    .limit(200);
  const list: MissedCallRow[] = rows.map((r) => ({
    ...r,
    display: r.from ? displayAu(r.from) : 'Private number',
    outcome: (r.outcome as MissedCallOutcome | null) ?? null,
    replied: Boolean(r.replied),
    aiReason: (r.aiReason as AiSkipReason | null) ?? null,
    aiPriority: priorityOf(r.aiPriority),
  }));
  return {
    rows: list,
    counts: {
      missed: list.length,
      texted: list.filter((r) => r.outcome === 'texted').length,
      replied: list.filter((r) => r.replied).length,
      waiting: list.filter((r) => !r.handledAt).length,
    },
    everyAgent,
  };
}

const priorityOf = (v: string | null): MissedCallRow['aiPriority'] => (v === 'high' || v === 'medium' || v === 'low' ? v : null);

export type MissedCallDetail = MissedCallRow & {
  /** Written by Retell's model from the call: the page labels it as the AI's (non-negotiable 7). */
  ai: { summary: string | null; transcript: string | null; recordingUrl: string | null; durationS: number | null; endedAt: Date | null };
  agentUserId: string;
  text: { body: string; status: string; error: string | null; at: Date } | null;
  replies: { body: string; at: Date }[];
  handledByName: string | null;
  canHandle: boolean;
  textsHref: string | null;
};

export async function getMissedCall(db: DbOrTx, actor: Actor, callId: string): Promise<MissedCallDetail> {
  if (!actor.agencyId) throw new PhoneError('forbidden', 'You do not have access to missed calls.');
  const [c] = await db
    .select({ call: phoneCall, agentUserId: phoneNumber.userId, agentName: sql<string>`coalesce(${user.name}, ${user.email})` })
    .from(phoneCall)
    .innerJoin(phoneNumber, eq(phoneNumber.id, phoneCall.phoneNumberId))
    .innerJoin(user, eq(user.id, phoneNumber.userId))
    .where(and(eq(phoneCall.id, callId), eq(phoneCall.agencyId, actor.agencyId), eq(phoneCall.kind, 'missed')))
    .limit(1);
  if (!c || !can(actor, 'sms:read', { type: 'sms', agencyId: c.call.agencyId, ownerId: c.agentUserId })) throw new PhoneError('not_found', 'That missed call is not one you can open.');
  const call = c.call;
  const [text] = call.smsMessageId
    ? await db.select({ body: smsMessage.body, status: smsMessage.status, error: smsMessage.error, at: smsMessage.createdAt }).from(smsMessage).where(eq(smsMessage.id, call.smsMessageId)).limit(1)
    : [];
  const replies = call.fromE164
    ? await db
        .select({ body: smsMessage.body, at: smsMessage.createdAt })
        .from(smsMessage)
        .where(and(eq(smsMessage.phoneNumberId, call.phoneNumberId), eq(smsMessage.counterpart, call.fromE164), eq(smsMessage.direction, 'in'), gt(smsMessage.createdAt, call.createdAt)))
        .orderBy(smsMessage.createdAt)
        .limit(10)
    : [];
  const contact = call.contactId ? (await db.execute<{ name: string }>(sql`select name from contact where id = ${call.contactId} and agency_id = ${call.agencyId}`))[0] : undefined;
  const [handler] = call.handledBy ? await db.select({ name: sql<string>`coalesce(${user.name}, ${user.email})` }).from(user).where(eq(user.id, call.handledBy)).limit(1) : [];
  return {
    id: call.id,
    at: call.createdAt,
    from: call.fromE164,
    display: call.fromE164 ? displayAu(call.fromE164) : 'Private number',
    contactId: call.contactId,
    contactName: contact?.name ?? null,
    agentName: c.agentName,
    agentUserId: c.agentUserId,
    phoneNumberId: call.phoneNumberId,
    outcome: (call.outcome as MissedCallOutcome | null) ?? null,
    textStatus: text?.status ?? null,
    replied: replies.length > 0,
    handledAt: call.handledAt,
    aiStatus: call.aiStatus,
    aiReason: (call.aiReason as AiSkipReason | null) ?? null,
    aiPriority: priorityOf(call.aiPriority),
    aiDueAt: call.aiDueAt,
    ai: { summary: call.aiSummary, transcript: call.aiTranscript, recordingUrl: call.aiRecordingUrl, durationS: call.aiDurationS, endedAt: call.aiEndedAt },
    text: text ?? null,
    replies,
    handledByName: handler?.name ?? null,
    canHandle: can(actor, 'missed_call:handle', { type: 'phone_call', agencyId: call.agencyId, ownerId: c.agentUserId }),
    textsHref: call.fromE164 ? `${textsPathFor(actor.membershipRole)}?n=${call.phoneNumberId}&with=${encodeURIComponent(call.fromE164)}` : null,
  };
}

/** Marks a missed call dealt with (or not, `handled: false`). */
export async function markMissedCallHandled(db: DbOrTx, actor: Actor, callId: string, handled = true): Promise<void> {
  if (!actor.agencyId) throw new PhoneError('forbidden', 'You do not have access to missed calls.');
  const [c] = await db
    .select({ id: phoneCall.id, agencyId: phoneCall.agencyId, ownerId: phoneNumber.userId })
    .from(phoneCall)
    .innerJoin(phoneNumber, eq(phoneNumber.id, phoneCall.phoneNumberId))
    .where(and(eq(phoneCall.id, callId), eq(phoneCall.agencyId, actor.agencyId), eq(phoneCall.kind, 'missed')))
    .limit(1);
  if (!c || !can(actor, 'missed_call:handle', { type: 'phone_call', agencyId: c.agencyId, ownerId: c.ownerId })) throw new PhoneError('not_found', 'That missed call is not one you can change.');
  await db
    .update(phoneCall)
    .set(handled ? { handledAt: new Date(), handledBy: actor.userId, updatedAt: sql`now()` } : { handledAt: null, handledBy: null, updatedAt: sql`now()` })
    .where(eq(phoneCall.id, c.id));
}
