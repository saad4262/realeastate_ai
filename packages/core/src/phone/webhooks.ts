import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { membership, notification, phoneAccount, phoneCall, phoneNumber, smsMessage, smsOptOut, user, type Db } from '@repo/db';
import { decryptToken, type TokenKeys } from '../integrations/crypto';
import { displayAu, smsKeyword, SMS_MAX_LENGTH, toAuE164, validTwilioSignature, verifyWebhookToken, WEBHOOK_KINDS, type WebhookKind } from './format';
import { recordMissedCall } from './missed-calls';
import { contactByPhone, phoneDepsFromEnv, textsPathFor, type PhoneDeps } from './setup';
import type { VoiceAi } from './voice';

/**
 * What Twilio tells us (ADR 0070), on `/api/phone/twilio/<token>/<kind>` of the web app:
 * - `sms`: a text to an agent's number — kept in its conversation, STOP/START honoured, the agent told;
 * - `sms-status`: what became of a text we sent;
 * - `voice`: a call to an agent's number — the forwarding test coming back, or a caller the agent
 *   missed (kept and told, and texted only behind the "Missed call text" skill: missed-calls.ts);
 * - `caller-id`: Twilio's answer on an agent's mobile verification.
 *
 * The token in the URL names one number and is an HMAC only this server can make. On an agency's own
 * Twilio it is the only credential (we do not hold that account's Auth Token). On a managed subaccount
 * (ADR 0096) Twilio's signature is checked too, against the stored Auth Token or, during a rotation, its
 * secondary: a leaked URL alone is not enough there. Everything Twilio sends is form data we treat as
 * untrusted text.
 */

export type TwilioWebhookResult = { status: number; contentType: string; body: string };

const XML = 'text/xml; charset=utf-8';
const twiml = (inner = '') => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const ok = (inner = ''): TwilioWebhookResult => ({ status: 200, contentType: XML, body: twiml(inner) });
const plain = (status: number, body: string): TwilioWebhookResult => ({ status, contentType: 'text/plain; charset=utf-8', body });

/** A caller's number as Twilio gave it: E.164, or an Australian number we can read, else null. */
function callerE164(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (/^\+\d{6,15}$/.test(v)) return v;
  return toAuE164(v);
}

/**
 * A managed number's request carries a signature by its subaccount's Auth Token (or the secondary, mid-rotation).
 * No stored token, or one this server cannot decrypt, refuses: fail closed. The URL may be the one the
 * request arrived on or the one we gave Twilio (PHONE_WEBHOOK_BASE), which differ behind a proxy.
 */
function signedByTwilio(accountId: string, authToken: string | null, authTokenNext: string | null, opts: { keys: TokenKeys | null; token: string; kind: string; params: Record<string, string>; signature?: string | null; url?: string | null; webhookBase?: string | null }): boolean {
  const tokens: string[] = [];
  for (const [stored, column] of [[authToken, 'twilio_auth_token'], [authTokenNext, 'twilio_auth_token_next']] as const) {
    if (!stored) continue;
    try {
      tokens.push(decryptToken(stored, { rowId: accountId, column }, opts.keys!));
    } catch {
      console.error('[phone] a managed account\'s auth token cannot be decrypted on this server', accountId);
    }
  }
  const urls = [opts.url, opts.webhookBase && `${opts.webhookBase.replace(/\/+$/, '')}/api/phone/twilio/${opts.token}/${opts.kind}`].filter((u): u is string => !!u);
  return validTwilioSignature(opts.signature ?? null, urls, opts.params, tokens);
}

const SMS_STATUSES = new Set(['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed']);
const TEST_WINDOW_MS = 5 * 60 * 1000;

export async function handleTwilioWebhook(opts: {
  db: () => Db;
  token: string;
  kind: string;
  params: Record<string, string>;
  keys: TokenKeys | null;
  /** Sends a missed-call text. Default: the env's (the dev stub when PHONE_STUB=1). */
  client?: PhoneDeps['client'];
  /** For the missed-call text's delivery callback, and one of the URLs a signature may be over. */
  webhookBase?: string | null;
  /** `X-Twilio-Signature`, and the URL the request came in on (ADR 0096: checked on managed numbers). */
  signature?: string | null;
  url?: string | null;
  /** Retell (or the dev stub): an AI call back is scheduled only when there is one (ADR 0072). */
  voice?: VoiceAi | null;
  now?: Date;
}): Promise<TwilioWebhookResult> {
  if (!opts.keys) return plain(503, 'not configured');
  if (!(WEBHOOK_KINDS as readonly string[]).includes(opts.kind)) return plain(404, 'not found');
  const numberId = verifyWebhookToken(opts.token, opts.keys);
  if (!numberId) return plain(403, 'forbidden');
  const db = opts.db();
  const now = opts.now ?? new Date();
  const [n] = await db
    .select({ id: phoneNumber.id, agencyId: phoneNumber.agencyId, userId: phoneNumber.userId, accountId: phoneNumber.accountId, e164: phoneNumber.e164, callerIdE164: phoneNumber.callerIdE164, retellRegisteredAt: phoneNumber.retellRegisteredAt, status: phoneNumber.status, agentName: sql<string>`coalesce(${user.name}, ${user.email})`, role: membership.role, accountKind: phoneAccount.kind, authToken: phoneAccount.authToken, authTokenNext: phoneAccount.authTokenNext })
    .from(phoneNumber)
    .innerJoin(user, eq(user.id, phoneNumber.userId))
    .leftJoin(membership, and(eq(membership.userId, phoneNumber.userId), eq(membership.agencyId, phoneNumber.agencyId)))
    .leftJoin(phoneAccount, eq(phoneAccount.id, phoneNumber.accountId))
    .where(eq(phoneNumber.id, numberId))
    .limit(1);
  if (!n) return plain(404, 'not found');
  const p = opts.params;
  if (n.accountKind === 'managed' && !signedByTwilio(n.accountId!, n.authToken, n.authTokenNext, opts)) return plain(403, 'forbidden');

  switch (opts.kind as WebhookKind) {
    case 'sms': {
      const from = callerE164(p.From);
      const sid = (p.MessageSid || p.SmsSid || '').slice(0, 64);
      if (!from || !sid) return plain(400, 'bad request');
      if (n.status !== 'active') return ok();
      const body = (p.Body ?? '').slice(0, SMS_MAX_LENGTH);
      const who = await contactByPhone(db, n.agencyId, from);
      await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(smsMessage)
          .values({ agencyId: n.agencyId, phoneNumberId: n.id, counterpart: from, contactId: who?.id ?? null, direction: 'in', body, status: 'received', providerSid: sid })
          .onConflictDoNothing({ target: smsMessage.providerSid })
          .returning({ id: smsMessage.id });
        if (!row) return; // Twilio sent it twice
        const word = smsKeyword(body);
        if (word === 'stop') await tx.insert(smsOptOut).values({ agencyId: n.agencyId, e164: from }).onConflictDoNothing();
        if (word === 'start') await tx.delete(smsOptOut).where(and(eq(smsOptOut.agencyId, n.agencyId), eq(smsOptOut.e164, from)));
        const name = who?.name ?? displayAu(from);
        await tx
          .insert(notification)
          .values({
            userId: n.userId,
            agencyId: n.agencyId,
            kind: 'sms',
            title: word === 'stop' ? `${name} replied STOP: no more texts to them` : `Text from ${name}`.slice(0, 300),
            body: body.slice(0, 280),
            href: `${textsPathFor(n.role)}?n=${n.id}&with=${encodeURIComponent(from)}`,
            dedupeKey: `sms:${sid}`,
          })
          .onConflictDoNothing();
      });
      return ok();
    }

    case 'sms-status': {
      const sid = (p.MessageSid || p.SmsSid || '').slice(0, 64);
      const status = (p.MessageStatus || p.SmsStatus || '').toLowerCase();
      if (!sid || !SMS_STATUSES.has(status)) return ok();
      const mapped = status === 'sending' ? 'queued' : status;
      const failed = mapped === 'failed' || mapped === 'undelivered';
      await db
        .update(smsMessage)
        .set({ status: mapped, ...(failed ? { error: `Not delivered${p.ErrorCode ? ` (Twilio error ${String(p.ErrorCode).slice(0, 8)})` : ''}.` } : {}), updatedAt: sql`now()` })
        .where(and(eq(smsMessage.providerSid, sid), eq(smsMessage.agencyId, n.agencyId), eq(smsMessage.direction, 'out')));
      return ok();
    }

    case 'voice': {
      const callSid = (p.CallSid || '').slice(0, 64);
      const from = callerE164(p.From);
      if (!callSid) return plain(400, 'bad request');
      // The forwarding test coming back: our own test call, forwarded by the agent's network to this number.
      const [test] = await db
        .select({ id: phoneCall.id })
        .from(phoneCall)
        .where(and(eq(phoneCall.phoneNumberId, n.id), eq(phoneCall.kind, 'test'), eq(phoneCall.status, 'calling'), gt(phoneCall.createdAt, new Date(now.getTime() - TEST_WINDOW_MS))))
        .orderBy(desc(phoneCall.createdAt))
        .limit(1);
      const forwardedFrom = callerE164(p.ForwardedFrom);
      if (test && (from === n.e164 || (forwardedFrom && forwardedFrom === n.callerIdE164))) {
        await db.transaction(async (tx) => {
          await tx.update(phoneCall).set({ status: 'passed', updatedAt: sql`now()` }).where(eq(phoneCall.id, test.id));
          await tx.update(phoneNumber).set({ forwardingTestedAt: now, updatedAt: sql`now()` }).where(eq(phoneNumber.id, n.id));
        });
        return ok('<Hangup/>');
      }
      if (n.status !== 'active') return ok('<Hangup/>');
      // A caller the agent did not answer (ADR 0071): kept, the agent told, and texted only while the
      // "Missed call text" skill is on for the agency and the agent.
      const deps = { keys: opts.keys, client: opts.client ?? phoneDepsFromEnv().client, webhookBase: opts.webhookBase ?? null, voice: opts.voice ?? null };
      return ok(await recordMissedCall(db, { id: n.id, agencyId: n.agencyId, userId: n.userId, accountId: n.accountId, e164: n.e164, agentName: n.agentName, role: n.role, retellRegisteredAt: n.retellRegisteredAt }, callSid, from, deps));
    }

    case 'caller-id': {
      const status = (p.VerificationStatus || '').toLowerCase();
      if (status === 'success') {
        await db.update(phoneNumber).set({ callerIdStatus: 'verified', callerIdCheckedAt: now, updatedAt: sql`now()` }).where(eq(phoneNumber.id, n.id));
      } else if (status === 'failed') {
        await db.update(phoneNumber).set({ callerIdStatus: 'none', callerIdCheckedAt: now, updatedAt: sql`now()` }).where(and(eq(phoneNumber.id, n.id), eq(phoneNumber.callerIdStatus, 'pending')));
      }
      return ok();
    }
  }
}
