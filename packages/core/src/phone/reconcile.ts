import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { emailBatchRecipient, phoneNumber, smsMessage, type Db } from '@repo/db';
import { enqueueJob, type JobHandler } from '../jobs';
import { numberTwilio, type PhoneDeps } from './setup';
import type { TwilioApi } from './twilio';

/**
 * Texts whose answer was lost (PLATFORM-PLAN 3.9). A text is recorded `queued` before Twilio is called and gets
 * Twilio's SID after; a run that dies between the two leaves a row that may or may not have gone. It is never
 * sent again on its own: a job asks Twilio. Found → it went (status and SID recorded). Not found → it did not
 * (`failed`, with a reason the agency sees, and Send again stays a person's choice).
 */
export const STUCK_AFTER_MS = 15 * 60_000;
const LOOKBACK_MS = 3 * 86_400_000;
export const NOT_SENT = 'Not sent: Twilio has no record of this text. Send it again if it is still wanted.';

/** Every 5 minutes from the tick: enqueue a check per stuck text (once each), and put back batch recipients whose text was never started. */
export async function enqueueStuckSms(db: Db, now: Date): Promise<{ enqueued: number; requeued: number }> {
  const before = new Date(now.getTime() - STUCK_AFTER_MS).toISOString();
  const after = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const stuck = await db.execute<{ id: string; agency_id: string }>(sql`
    select id, agency_id from sms_message
    where direction = 'out' and status = 'queued' and provider_sid is null
      and created_at < ${before}::timestamptz and created_at > ${after}::timestamptz
    order by created_at limit 200`);
  let enqueued = 0;
  for (const s of stuck) {
    if (await enqueueJob(db, { kind: 'sms.reconcile', lane: 'urgent', agencyId: s.agency_id, payload: { smsMessageId: s.id }, dedupeKey: s.id })) enqueued += 1;
  }
  // Claimed for sending but no text row yet: the run died before Twilio was called, so nothing went. Safe to queue again.
  const requeued = await db.execute(sql`
    update email_batch_recipient r set status = 'queued', updated_at = now()
    from email_batch b
    where b.id = r.batch_id and b.channel = 'sms'
      and r.status = 'sending' and r.sms_message_id is null and r.updated_at < ${before}::timestamptz
    returning r.id`);
  return { enqueued, requeued: requeued.length };
}

type TwilioForNumber = (db: Db, n: { accountId: string | null }) => Promise<TwilioApi>;

/** The `sms.reconcile` job. Idempotent: a text no longer stuck (settled by a webhook or an earlier run) is left alone. */
export function smsReconcileHandler(deps: PhoneDeps, twilioFor: TwilioForNumber = async (db, n) => (await numberTwilio(db, n, deps)).client): JobHandler {
  return async (db, j) => {
    const id = String((j.payload as { smsMessageId?: unknown }).smsMessageId ?? '');
    // PLATFORM-PLAN 4.9: a job acts only on its own agency's rows, whatever its payload names.
    if (!j.agencyId) return;
    const [row] = await db.select().from(smsMessage).where(and(eq(smsMessage.id, id), eq(smsMessage.agencyId, j.agencyId))).limit(1);
    if (!row || row.status !== 'queued' || row.providerSid) return;
    const [num] = await db.select({ accountId: phoneNumber.accountId, e164: phoneNumber.e164 }).from(phoneNumber).where(eq(phoneNumber.id, row.phoneNumberId)).limit(1);
    if (!num) throw new Error('The text’s number no longer exists');
    const client = await twilioFor(db, num);
    const from = row.createdAt.getTime() - 2 * 60_000;
    const until = row.createdAt.getTime() + STUCK_AFTER_MS;
    const candidates = (await client.findMessages({ from: num.e164, to: row.counterpart, since: row.createdAt })).filter(
      (m) => m.body.trim() === row.body.trim() && (!m.createdAt || (m.createdAt.getTime() >= from && m.createdAt.getTime() <= until)),
    );
    // A SID already on another row is that row's text, not this one's (the same words sent twice).
    const taken = candidates.length
      ? new Set((await db.select({ sid: smsMessage.providerSid }).from(smsMessage).where(inArray(smsMessage.providerSid, candidates.map((c) => c.sid)))).map((r) => r.sid))
      : new Set<string | null>();
    const match = candidates.find((c) => !taken.has(c.sid));

    await db.transaction(async (tx) => {
      const still = and(eq(smsMessage.id, row.id), eq(smsMessage.status, 'queued'), isNull(smsMessage.providerSid));
      if (match) {
        const status = ['failed', 'undelivered'].includes(match.status) ? 'failed' : ['sent', 'delivered'].includes(match.status) ? 'sent' : 'queued';
        const [done] = await tx.update(smsMessage).set({ status, providerSid: match.sid, updatedAt: sql`now()` }).where(still).returning({ id: smsMessage.id });
        if (done && status !== 'failed') {
          await tx.update(emailBatchRecipient).set({ status: 'sent', sentAt: sql`now()`, error: null, updatedAt: sql`now()` }).where(and(eq(emailBatchRecipient.smsMessageId, row.id), eq(emailBatchRecipient.status, 'sending')));
        }
        return;
      }
      const [done] = await tx.update(smsMessage).set({ status: 'failed', error: NOT_SENT, updatedAt: sql`now()` }).where(still).returning({ id: smsMessage.id });
      if (done) {
        await tx.update(emailBatchRecipient).set({ status: 'failed', error: NOT_SENT, updatedAt: sql`now()` }).where(and(eq(emailBatchRecipient.smsMessageId, row.id), eq(emailBatchRecipient.status, 'sending')));
      }
    });
  };
}
