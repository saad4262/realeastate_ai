import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, gt, sql } from 'drizzle-orm';
import { phoneNumber, smsMessage, smsOptOut, smsRead, user, type Db, type DbOrTx } from '@repo/db';
import { can, isAgencyAdminRole, type Actor } from '../permissions';
import { displayAu, isAuMobile, SMS_MAX_LENGTH, toAuE164, webhookUrl } from './format';
import { agencyTwilio, contactByPhone, myNumber, PhoneError, providerFailure, type PhoneDeps } from './setup';

/**
 * Texts (ADR 0070): an agent texts from their own Twilio number, one person at a time, and the replies
 * come back into the same conversation. A conversation is (the agent's number, the other person's
 * number). Nobody who replied STOP is texted again; each agent has a daily ceiling on what they send.
 */

export const DEFAULT_SMS_LIMIT_PER_AGENT_DAY = 100;

export function smsLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SMS_LIMIT_PER_AGENT_DAY);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SMS_LIMIT_PER_AGENT_DAY;
}

export async function isOptedOut(db: DbOrTx, agencyId: string, e164: string): Promise<boolean> {
  const [row] = await db.select({ e164: smsOptOut.e164 }).from(smsOptOut).where(and(eq(smsOptOut.agencyId, agencyId), eq(smsOptOut.e164, e164))).limit(1);
  return Boolean(row);
}

export async function sendSms(
  db: Db,
  actor: Actor,
  input: { to: string; body: string },
  deps: PhoneDeps & { limitPerDay?: number },
): Promise<{ id: string }> {
  const n = await myNumber(db, actor);
  if (!can(actor, 'sms:send', { type: 'sms', agencyId: n.agencyId, ownerId: n.userId })) throw new PhoneError('forbidden', 'You may not text from this number.');
  const to = toAuE164(input.to);
  if (!isAuMobile(to)) throw new PhoneError('invalid', 'Texts go to Australian mobile numbers (04…) only.');
  const body = input.body.trim();
  if (!body) throw new PhoneError('invalid', 'Write the message first.');
  if (body.length > SMS_MAX_LENGTH) throw new PhoneError('invalid', `A text can be at most ${SMS_MAX_LENGTH} characters.`);
  if (await isOptedOut(db, n.agencyId, to!)) throw new PhoneError('invalid', 'This number replied STOP, so the agency may not text it. It can text START to allow texts again.');
  const limit = deps.limitPerDay ?? DEFAULT_SMS_LIMIT_PER_AGENT_DAY;
  const [sent] = await db
    .select({ n: count() })
    .from(smsMessage)
    .where(and(eq(smsMessage.sentBy, actor.userId), eq(smsMessage.direction, 'out'), gt(smsMessage.createdAt, sql`now() - interval '24 hours'`)));
  if ((sent?.n ?? 0) >= limit) throw new PhoneError('invalid', `You have sent ${limit} texts in the last 24 hours, the most allowed. Try again later.`);

  const { client } = await agencyTwilio(db, n.agencyId, deps);
  const who = await contactByPhone(db, n.agencyId, to!);
  const id = randomUUID();
  // Written first as queued, so a send that never comes back is still on the record.
  await db.insert(smsMessage).values({ id, agencyId: n.agencyId, phoneNumberId: n.id, counterpart: to!, contactId: who?.id ?? null, direction: 'out', body, status: 'queued', sentBy: actor.userId });
  try {
    const statusUrl = deps.keys && deps.webhookBase ? webhookUrl(deps.webhookBase, n.id, 'sms-status', deps.keys) : null;
    const r = await client.sendSms({ from: n.e164, to: to!, body, statusUrl });
    await db.update(smsMessage).set({ status: r.status === 'sent' ? 'sent' : 'queued', providerSid: r.sid, updatedAt: sql`now()` }).where(eq(smsMessage.id, id));
  } catch (err) {
    const failure = providerFailure(err, 'Twilio refused to send with the saved key.');
    await db.update(smsMessage).set({ status: 'failed', error: failure.message, updatedAt: sql`now()` }).where(eq(smsMessage.id, id));
    throw failure;
  }
  return { id };
}

export type SmsConversationRow = {
  phoneNumberId: string;
  counterpart: string;
  display: string;
  contactId: string | null;
  contactName: string | null;
  agentName: string;
  lastBody: string;
  lastDirection: 'in' | 'out';
  lastAt: Date;
  unread: boolean;
};

/**
 * The conversations this person may read, newest first: an agent's own number; an owner or admin
 * every number in the agency. One statement.
 */
export async function listSmsConversations(db: DbOrTx, actor: Actor, limit = 100): Promise<SmsConversationRow[]> {
  if (!actor.agencyId || !actor.membershipRole) throw new PhoneError('forbidden', 'You do not have access to texts.');
  const everyNumber = isAgencyAdminRole(actor.membershipRole) && can(actor, 'sms:read', { type: 'sms', agencyId: actor.agencyId });
  const rows = await db.execute<{
    phone_number_id: string;
    counterpart: string;
    contact_id: string | null;
    contact_name: string | null;
    agent_name: string;
    body: string;
    direction: 'in' | 'out';
    created_at: Date | string;
    last_in: Date | string | null;
    last_read_at: Date | string | null;
  }>(sql`
    select * from (
      select distinct on (m.phone_number_id, m.counterpart)
        m.phone_number_id, m.counterpart, m.body, m.direction, m.created_at,
        coalesce(m.contact_id, (select x.contact_id from sms_message x where x.phone_number_id = m.phone_number_id and x.counterpart = m.counterpart and x.contact_id is not null order by x.created_at desc limit 1)) as contact_id,
        coalesce(u.name, u.email) as agent_name,
        (select max(i.created_at) from sms_message i where i.phone_number_id = m.phone_number_id and i.counterpart = m.counterpart and i.direction = 'in') as last_in,
        r.last_read_at
      from sms_message m
      join phone_number pn on pn.id = m.phone_number_id
      join "user" u on u.id = pn.user_id
      left join sms_read r on r.phone_number_id = m.phone_number_id and r.counterpart = m.counterpart and r.user_id = ${actor.userId}
      where m.agency_id = ${actor.agencyId} ${everyNumber ? sql`` : sql`and pn.user_id = ${actor.userId}`}
      order by m.phone_number_id, m.counterpart, m.created_at desc
    ) conv
    left join lateral (select c.name as contact_name from contact c where c.id = conv.contact_id) cn on true
    order by conv.created_at desc
    limit ${limit}`);
  const at = (v: Date | string | null) => (v == null ? null : v instanceof Date ? v : new Date(v));
  return rows.map((r) => {
    const lastIn = at(r.last_in);
    const read = at(r.last_read_at);
    return {
      phoneNumberId: r.phone_number_id,
      counterpart: r.counterpart,
      display: displayAu(r.counterpart),
      contactId: r.contact_id,
      contactName: r.contact_name,
      agentName: r.agent_name,
      lastBody: r.body.slice(0, 160),
      lastDirection: r.direction,
      lastAt: at(r.created_at)!,
      unread: Boolean(lastIn && (!read || lastIn > read)),
    };
  });
}

export type SmsConversationView = {
  phoneNumberId: string;
  numberDisplay: string;
  agentName: string;
  counterpart: string;
  display: string;
  contact: { id: string; name: string } | null;
  canSend: boolean;
  optedOut: boolean;
  messages: { id: string; direction: 'in' | 'out'; body: string; status: string; error: string | null; at: Date; byName: string | null; kind: string | null }[];
};

/** One conversation, oldest first (the last 300), marked read for this person. */
export async function getSmsConversation(db: Db, actor: Actor, phoneNumberId: string, counterpartRaw: string): Promise<SmsConversationView> {
  if (!actor.agencyId) throw new PhoneError('forbidden', 'You do not have access to texts.');
  const counterpart = counterpartRaw.startsWith('+') ? counterpartRaw : (toAuE164(counterpartRaw) ?? counterpartRaw);
  const [n] = await db
    .select({ id: phoneNumber.id, agencyId: phoneNumber.agencyId, userId: phoneNumber.userId, e164: phoneNumber.e164, status: phoneNumber.status, agentName: sql<string>`coalesce(${user.name}, ${user.email})` })
    .from(phoneNumber)
    .innerJoin(user, eq(user.id, phoneNumber.userId))
    .where(and(eq(phoneNumber.id, phoneNumberId), eq(phoneNumber.agencyId, actor.agencyId)))
    .limit(1);
  if (!n || !can(actor, 'sms:read', { type: 'sms', agencyId: n.agencyId, ownerId: n.userId })) throw new PhoneError('not_found', 'That conversation is not one you can open.');
  const rows = await db
    .select({ id: smsMessage.id, direction: smsMessage.direction, body: smsMessage.body, status: smsMessage.status, error: smsMessage.error, at: smsMessage.createdAt, kind: smsMessage.kind, contactId: smsMessage.contactId, byName: sql<string | null>`(select coalesce(u.name, u.email) from "user" u where u.id = sms_message.sent_by)` })
    .from(smsMessage)
    .where(and(eq(smsMessage.phoneNumberId, n.id), eq(smsMessage.counterpart, counterpart)))
    .orderBy(desc(smsMessage.createdAt))
    .limit(300);
  rows.reverse();
  const contactId = [...rows].reverse().find((r) => r.contactId)?.contactId ?? null;
  const contact = contactId ? await contactNamed(db, n.agencyId, contactId) : await contactByPhone(db, n.agencyId, counterpart);
  const optedOut = await isOptedOut(db, n.agencyId, counterpart);
  await db
    .insert(smsRead)
    .values({ phoneNumberId: n.id, counterpart, userId: actor.userId, agencyId: n.agencyId })
    .onConflictDoUpdate({ target: [smsRead.phoneNumberId, smsRead.counterpart, smsRead.userId], set: { lastReadAt: sql`now()` } });
  return {
    phoneNumberId: n.id,
    numberDisplay: displayAu(n.e164),
    agentName: n.agentName,
    counterpart,
    display: displayAu(counterpart),
    contact,
    canSend: n.status === 'active' && can(actor, 'sms:send', { type: 'sms', agencyId: n.agencyId, ownerId: n.userId }),
    optedOut,
    messages: rows.map((r) => ({ id: r.id, direction: r.direction, body: r.body, status: r.status, error: r.error, at: r.at, byName: r.byName, kind: r.kind })),
  };
}

async function contactNamed(db: DbOrTx, agencyId: string, id: string): Promise<{ id: string; name: string } | null> {
  const rows = await db.execute<{ id: string; name: string }>(sql`select id, name from contact where id = ${id} and agency_id = ${agencyId} limit 1`);
  return rows[0] ?? null;
}

