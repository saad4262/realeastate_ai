import { and, eq, inArray, sql } from 'drizzle-orm';
import { membership, notification, phoneAccount, phoneCall, phoneNumber, smsMessage, type Db } from '@repo/db';
import { isAgencyAdminRole } from '../permissions';
import { displayAu } from './format';
import { contactByPhone, numberTwilio, providerFailure, type PhoneDeps } from './setup';
import { recordInboundSms } from './webhooks';

export type PullInboundReport = { numbers: number; texts: number; calls: number; failed: { numberId: string; error: string }[] };

/** The tick looks back this far: an outage up to it is filled in on its own; a longer one needs the CLI. */
export const PULL_WINDOW_HOURS = 2;

/**
 * PLATFORM-PLAN 3.8: Twilio does not reliably retry a webhook we failed, so a text or a call that came in while we
 * were down is missing from the CRM though Twilio has it. This asks Twilio, number by number, what came in since
 * `since` and keeps what we do not have, by Twilio's SID, as the webhook would:
 * - a text: through `recordInboundSms` (conversation, STOP/START, the agent's bell);
 * - a call: a missed call (every call that reaches the Twilio number is one the agent's mobile did not take), with
 *   the outcome "found after an outage". It is not texted, called back or sent to workflows: hours late, an
 *   automatic reply would surprise the caller. The agent gets a bell to call them.
 * Network first, then a short write per item; one number's failure does not stop the rest. `shard`: the tick
 * takes one part in `of` (by a hash of the number's id) so its two Twilio calls per number fit in its time.
 * shortcut: at ~3,000 numbers a 1/30 shard is ~100 numbers a tick, about the tick's budget — move to the job queue then.
 */
export async function pullInbound(db: Db, deps: PhoneDeps, since: Date, shard?: { part: number; of: number }): Promise<PullInboundReport> {
  const numbers = await db
    .select({ id: phoneNumber.id, agencyId: phoneNumber.agencyId, userId: phoneNumber.userId, accountId: phoneNumber.accountId, e164: phoneNumber.e164, role: membership.role })
    .from(phoneNumber)
    .innerJoin(phoneAccount, and(eq(phoneAccount.id, phoneNumber.accountId), eq(phoneAccount.status, 'connected')))
    .leftJoin(membership, and(eq(membership.userId, phoneNumber.userId), eq(membership.agencyId, phoneNumber.agencyId)))
    .where(and(eq(phoneNumber.status, 'active'), shard ? sql`abs(hashtext(${phoneNumber.id}::text)) % ${shard.of} = ${shard.part}` : undefined));
  const report: PullInboundReport = { numbers: numbers.length, texts: 0, calls: 0, failed: [] };
  for (const n of numbers) {
    try {
      const { client } = await numberTwilio(db, n, deps);
      const found = await client.inboundSince({ to: n.e164, since });
      const calls = found.calls.filter((c) => c.from !== n.e164); // our own forwarding test calls itself
      const [haveTexts, haveCalls] = await Promise.all([
        found.messages.length ? db.select({ sid: smsMessage.providerSid }).from(smsMessage).where(inArray(smsMessage.providerSid, found.messages.map((m) => m.sid))) : [],
        calls.length ? db.select({ sid: phoneCall.callSid }).from(phoneCall).where(inArray(phoneCall.callSid, calls.map((c) => c.sid))) : [],
      ]);
      const known = new Set([...haveTexts, ...haveCalls].map((r) => r.sid));
      for (const m of found.messages) {
        if (!known.has(m.sid) && (await recordInboundSms(db, n, m))) report.texts += 1;
      }
      for (const c of calls) {
        if (!known.has(c.sid) && (await keepLateMissedCall(db, n, c))) report.calls += 1;
      }
    } catch (err) {
      report.failed.push({ numberId: n.id, error: providerFailure(err, 'Twilio refused the saved key.').message });
    }
  }
  return report;
}

async function keepLateMissedCall(db: Db, n: { id: string; agencyId: string; userId: string; role: string | null }, c: { sid: string; from: string | null }): Promise<boolean> {
  const from = c.from && /^\+\d{6,15}$/.test(c.from) ? c.from : null;
  const who = from ? await contactByPhone(db, n.agencyId, from) : null;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(phoneCall)
      .values({ agencyId: n.agencyId, phoneNumberId: n.id, kind: 'missed', callSid: c.sid.slice(0, 64), fromE164: from, contactId: who?.id ?? null, status: 'received', outcome: 'found_late' })
      .onConflictDoNothing({ target: phoneCall.callSid })
      .returning({ id: phoneCall.id });
    if (!row) return false;
    const name = who?.name ?? (from ? displayAu(from) : 'a private number');
    await tx
      .insert(notification)
      .values({
        userId: n.userId,
        agencyId: n.agencyId,
        kind: 'missed_call',
        title: `Missed call from ${name}`.slice(0, 300),
        body: 'Found after an outage on our side, so they were not texted. Call them back.',
        href: `${isAgencyAdminRole(n.role as never) ? '/missed-calls' : '/my-missed-calls'}?call=${row.id}`,
        dedupeKey: `call:${c.sid}`,
      })
      .onConflictDoNothing();
    return true;
  });
}
