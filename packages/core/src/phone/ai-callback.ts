import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { agency, aiRun, membership, note, notification, phoneAccount, phoneCall, phoneNumber, smsMessage, user, type Db, type DbOrTx } from '@repo/db';
import { can, isAgencyAdminRole, type Actor, type MembershipRole } from '../permissions';
import { decryptToken, encryptToken } from '../integrations/crypto';
import { isPairedSkillOn } from '../skill-switches/switches';
import { agencyTwilio, PhoneError, providerFailure, type PhoneDeps } from './setup';
import { isOptedOut } from './sms';
import { aiOutcomeOf, verifyRetellSignature, verifyRetellWebhookToken, type VoiceAi } from './voice';
import type { TokenKeys } from '../integrations/crypto';

/**
 * The AI call back (ADR 0072, Phase 3.3). A missed call whose caller may be called back is SCHEDULED
 * (by `recordMissedCall`), never called from the webhook: the minute tick places it when due, inside the
 * agency's calling hours, after checking again that nobody handled it, the caller didn't text back, and
 * the "AI call back" skill is still on for the agency and the agent. Retell's webhook brings back the
 * transcript, recording and its summary, which land on the contact labelled as the AI's.
 */

/** Matches packages/ai's AI_CALLBACK_PROMPT_VERSION (core does not import packages/ai). */
const PROMPT_VERSION = 'ai-callback@v1';

function managerAgency(actor: Actor): string {
  if (!actor.agencyId || !can(actor, 'phone:manage', { type: 'phone', agencyId: actor.agencyId })) throw new PhoneError('forbidden', "Only the agency's owners and admins can set up AI calls.");
  return actor.agencyId;
}

function strongPassword(): string {
  // Twilio SIP credentials: at least 12 characters with upper, lower and a digit.
  return `Ai${randomBytes(18).toString('base64url').replace(/[-_]/g, 'x')}9z`;
}

export type AiSetupView = { configured: boolean; stub: boolean; trunk: boolean; registered: number; total: number; errors: string[] };

export async function aiCallsStatus(db: DbOrTx, actor: Actor, voice: VoiceAi | null): Promise<AiSetupView> {
  if (!actor.agencyId || !can(actor, 'phone:read', { type: 'phone', agencyId: actor.agencyId })) throw new PhoneError('forbidden', 'You do not have access to the phone setup.');
  const [acct] = await db.select({ trunk: phoneAccount.sipTrunkSid }).from(phoneAccount).where(eq(phoneAccount.agencyId, actor.agencyId)).limit(1);
  const nums = await db
    .select({ registered: phoneNumber.retellRegisteredAt, error: phoneNumber.retellError })
    .from(phoneNumber)
    .where(and(eq(phoneNumber.agencyId, actor.agencyId), eq(phoneNumber.status, 'active')));
  return {
    configured: Boolean(voice),
    stub: Boolean(voice?.stub),
    trunk: Boolean(acct?.trunk),
    registered: nums.filter((n) => n.registered).length,
    total: nums.length,
    errors: nums.map((n) => n.error).filter((e): e is string => Boolean(e)),
  };
}

/**
 * "Set up AI calls": a SIP trunk on the agency's Twilio (once), then each active number registered with
 * Retell. Safe to press again: it only does what is missing. Network calls happen outside transactions.
 */
export async function setUpAiCalls(db: Db, actor: Actor, deps: PhoneDeps, voice: VoiceAi | null): Promise<{ registered: number; failed: number }> {
  const agencyId = managerAgency(actor);
  if (!voice) throw new PhoneError('not_configured', 'AI calls are not set up on this server yet (RETELL_API_KEY and RETELL_AGENT_ID are missing).');
  if (!deps.keys) throw new PhoneError('not_configured', 'Phone & SMS is not set up on this server yet (INTEGRATION_TOKEN_KEY is missing).');
  const keys = deps.keys;
  const { account, client } = await agencyTwilio(db, agencyId, deps);
  let { sipDomain, sipUsername } = account;
  let password: string;
  if (!account.sipTrunkSid || !sipDomain || !sipUsername || !account.sipPassword) {
    sipUsername = `la${randomBytes(4).toString('hex')}`;
    password = strongPassword();
    let trunk: { trunkSid: string; domain: string };
    try {
      trunk = await client.createSipTrunk({ friendlyName: 'LocalAgent AI calls', domainPrefix: `la-${randomBytes(5).toString('hex')}`, username: sipUsername, password });
    } catch (err) {
      throw providerFailure(err, 'Twilio refused to create the SIP trunk with the saved key. The API key needs access to Elastic SIP Trunking.');
    }
    sipDomain = trunk.domain;
    await db
      .update(phoneAccount)
      .set({ sipTrunkSid: trunk.trunkSid, sipDomain, sipUsername, sipPassword: encryptToken(password, { rowId: account.id, column: 'sip_password' }, keys), updatedAt: sql`now()` })
      .where(eq(phoneAccount.id, account.id));
  } else {
    password = decryptToken(account.sipPassword, { rowId: account.id, column: 'sip_password' }, keys);
  }
  const pending = await db
    .select({ id: phoneNumber.id, e164: phoneNumber.e164, name: sql<string>`coalesce(${user.name}, ${user.email})` })
    .from(phoneNumber)
    .innerJoin(user, eq(user.id, phoneNumber.userId))
    .where(and(eq(phoneNumber.agencyId, agencyId), eq(phoneNumber.status, 'active'), isNull(phoneNumber.retellRegisteredAt)));
  let registered = 0;
  let failed = 0;
  for (const n of pending) {
    try {
      await voice.registerNumber({ e164: n.e164, terminationUri: sipDomain!, username: sipUsername!, password, nickname: `${n.name} (LocalAgent)` });
      await db.update(phoneNumber).set({ retellRegisteredAt: new Date(), retellError: null, updatedAt: sql`now()` }).where(eq(phoneNumber.id, n.id));
      registered += 1;
    } catch (err) {
      failed += 1;
      const msg = providerFailure(err, 'Retell refused the number.').message;
      await db.update(phoneNumber).set({ retellError: msg.slice(0, 300), updatedAt: sql`now()` }).where(eq(phoneNumber.id, n.id));
    }
  }
  return { registered, failed };
}

// ── The tick: place the AI calls that are due ───────────────────────────────

type Claimed = { id: string; agency_id: string; phone_number_id: string; from_e164: string | null; contact_id: string | null; created_at: Date | string; handled_at: Date | string | null };

export async function runDueAiCallbacks(
  db: Db,
  voice: VoiceAi | null,
  now = new Date(),
  limit = 5,
  /** Only one agency's calls (the smoke suite); the tick takes every agency's. */
  only: { agencyId?: string } = {},
): Promise<{ placed: number; skipped: number; failed: number }> {
  const report = { placed: 0, skipped: 0, failed: 0 };
  if (!voice) return report;
  // Claim (one statement, so two ticks never take the same call): due and still scheduled → calling.
  const claimed = await db.execute<Claimed>(sql`
    update phone_call set ai_status = 'calling', updated_at = now()
    where id in (
      select id from phone_call where ai_status = 'scheduled' and ai_due_at <= ${now}
      ${only.agencyId ? sql`and agency_id = ${only.agencyId}` : sql``}
      order by ai_due_at limit ${limit} for update skip locked)
    returning id, agency_id, phone_number_id, from_e164, contact_id, created_at, handled_at`);
  for (const c of claimed) {
    const skip = async (reason: string) => {
      report.skipped += 1;
      await db.update(phoneCall).set({ aiStatus: 'skipped', aiReason: reason, updatedAt: sql`now()` }).where(eq(phoneCall.id, c.id));
    };
    const [n] = await db
      .select({ id: phoneNumber.id, e164: phoneNumber.e164, userId: phoneNumber.userId, status: phoneNumber.status, registered: phoneNumber.retellRegisteredAt, agentName: sql<string>`coalesce(${user.name}, ${user.email})`, role: membership.role, agencyName: agency.name })
      .from(phoneNumber)
      .innerJoin(user, eq(user.id, phoneNumber.userId))
      .innerJoin(agency, eq(agency.id, phoneNumber.agencyId))
      .leftJoin(membership, and(eq(membership.userId, phoneNumber.userId), eq(membership.agencyId, phoneNumber.agencyId), eq(membership.status, 'active')))
      .where(eq(phoneNumber.id, c.phone_number_id))
      .limit(1);
    if (!n || n.status !== 'active' || !n.registered || !c.from_e164) {
      await skip('not_ready');
      continue;
    }
    if (c.handled_at) {
      await skip('handled');
      continue;
    }
    const createdAt = c.created_at instanceof Date ? c.created_at : new Date(c.created_at);
    const [reply] = await db
      .select({ id: smsMessage.id })
      .from(smsMessage)
      .where(and(eq(smsMessage.phoneNumberId, n.id), eq(smsMessage.counterpart, c.from_e164), eq(smsMessage.direction, 'in'), gt(smsMessage.createdAt, createdAt)))
      .limit(1);
    if (reply) {
      await skip('replied');
      continue;
    }
    if (!n.role || !(await isPairedSkillOn(db, c.agency_id, n.userId, n.role as MembershipRole, 'ai_callback'))) {
      await skip('skill_off');
      continue;
    }
    if (await isOptedOut(db, c.agency_id, c.from_e164)) {
      await skip('opted_out');
      continue;
    }
    const caller = c.contact_id ? (await db.execute<{ name: string }>(sql`select name from contact where id = ${c.contact_id} and agency_id = ${c.agency_id}`))[0]?.name : null;
    try {
      const { callId } = await voice.createCall({
        fromE164: n.e164,
        toE164: c.from_e164,
        variables: { agent_first_name: (n.agentName.split(/[\s@]/)[0] || 'the agent'), agency_name: n.agencyName, caller_first_name: (caller?.split(/\s+/)[0] || 'there') },
        metadata: { phoneCallId: c.id, agencyId: c.agency_id },
      });
      await db.update(phoneCall).set({ aiCallId: callId, updatedAt: sql`now()` }).where(eq(phoneCall.id, c.id));
      report.placed += 1;
    } catch (err) {
      report.failed += 1;
      console.error('[phone] ai call not placed', err instanceof Error ? err.message : err);
      await db.update(phoneCall).set({ aiStatus: 'failed', aiReason: 'provider', updatedAt: sql`now()` }).where(eq(phoneCall.id, c.id));
    }
  }
  return report;
}

// ── Retell's webhook ────────────────────────────────────────────────────────

export type RetellWebhookResult = { status: number; body: Record<string, unknown> };

const PRIORITIES = new Set(['high', 'medium', 'low']);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);

export async function handleRetellWebhook(opts: {
  db: () => Db;
  token: string;
  rawBody: string;
  signature: string | null;
  keys: TokenKeys | null;
  apiKey: string | null;
  verifySignature: boolean;
  now?: Date;
}): Promise<RetellWebhookResult> {
  if (!opts.keys) return { status: 503, body: { error: 'not configured' } };
  if (!verifyRetellWebhookToken(opts.token, opts.keys)) return { status: 403, body: { error: 'forbidden' } };
  if (opts.verifySignature && (!opts.apiKey || !verifyRetellSignature(opts.rawBody, opts.signature, opts.apiKey, (opts.now ?? new Date()).getTime()))) {
    return { status: 401, body: { error: 'bad signature' } };
  }
  let payload: { event?: unknown; call?: Record<string, unknown> };
  try {
    payload = JSON.parse(opts.rawBody) as typeof payload;
  } catch {
    return { status: 400, body: { error: 'bad json' } };
  }
  const event = typeof payload.event === 'string' ? payload.event : '';
  const call = payload.call && typeof payload.call === 'object' ? payload.call : {};
  const callId = text(call.call_id, 64);
  if (!callId) return { status: 400, body: { error: 'no call id' } };
  const db = opts.db();
  const [row] = await db
    .select({ id: phoneCall.id, agencyId: phoneCall.agencyId, contactId: phoneCall.contactId, from: phoneCall.fromE164, status: phoneCall.aiStatus, summary: phoneCall.aiSummary, userId: phoneNumber.userId, role: membership.role })
    .from(phoneCall)
    .innerJoin(phoneNumber, eq(phoneNumber.id, phoneCall.phoneNumberId))
    .leftJoin(membership, and(eq(membership.userId, phoneNumber.userId), eq(membership.agencyId, phoneNumber.agencyId)))
    .where(eq(phoneCall.aiCallId, callId))
    .limit(1);
  // Only a call we placed, and only with our own id in its metadata.
  if (!row) return { status: 404, body: { error: 'unknown call' } };
  const meta = call.metadata && typeof call.metadata === 'object' ? (call.metadata as Record<string, unknown>) : {};
  if (meta.phoneCallId !== row.id) return { status: 403, body: { error: 'forbidden' } };

  if (event === 'call_ended') {
    const start = typeof call.start_timestamp === 'number' ? call.start_timestamp : null;
    const end = typeof call.end_timestamp === 'number' ? call.end_timestamp : null;
    const recording = text(call.recording_url, 2000);
    await db
      .update(phoneCall)
      .set({
        aiStatus: aiOutcomeOf(text(call.disconnection_reason, 64)),
        aiEndedAt: end ? new Date(end) : new Date(),
        aiDurationS: start && end && end > start ? Math.round((end - start) / 1000) : null,
        aiTranscript: text(call.transcript, 20000),
        aiRecordingUrl: recording && recording.startsWith('https://') ? recording : null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(phoneCall.id, row.id), eq(phoneCall.aiStatus, 'calling')));
    return { status: 200, body: { ok: true } };
  }

  if (event === 'call_analyzed' && !row.summary) {
    const analysis = call.call_analysis && typeof call.call_analysis === 'object' ? (call.call_analysis as Record<string, unknown>) : {};
    const custom = analysis.custom_analysis_data && typeof analysis.custom_analysis_data === 'object' ? (analysis.custom_analysis_data as Record<string, unknown>) : {};
    const summary = text(analysis.call_summary, 2000);
    const priority = typeof custom.priority === 'string' && PRIORITIES.has(custom.priority) ? custom.priority : null;
    const cost = call.call_cost && typeof call.call_cost === 'object' ? (call.call_cost as Record<string, unknown>).combined_cost : null;
    await db.transaction(async (tx) => {
      await tx.update(phoneCall).set({ aiSummary: summary ?? '', aiPriority: priority, updatedAt: sql`now()` }).where(eq(phoneCall.id, row.id));
      if (summary && row.contactId) {
        await tx.insert(note).values({ agencyId: row.agencyId, contactId: row.contactId, authorId: null, body: `AI call back — written by the AI from the call; check it before you act:\n${summary}` });
      }
      await tx
        .insert(notification)
        .values({
          userId: row.userId,
          agencyId: row.agencyId,
          kind: 'ai_call',
          title: `AI spoke to ${row.from ?? 'a caller'}${priority === 'high' ? ' · high priority' : ''}`.slice(0, 300),
          body: summary ? `Written by the AI: ${summary.slice(0, 400)}` : 'The call ended without a summary.',
          href: `${isAgencyAdminRole(row.role as MembershipRole | null) ? '/missed-calls' : '/my-missed-calls'}?call=${row.id}`,
          dedupeKey: `ai:${callId}`,
        })
        .onConflictDoNothing();
      // Retell's own figure for what the call cost (cents), metered like any AI run.
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
        await tx.insert(aiRun).values({ feature: 'ai_callback', model: 'retell', costUsd: (cost / 100).toFixed(6), entityId: row.id, userId: row.userId, agencyId: row.agencyId, promptVersion: PROMPT_VERSION });
      }
    });
  }
  return { status: 200, body: { ok: true } };
}
