import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import {
  activity,
  contact,
  contactFilter,
  emailBatch,
  emailBatchRecipient,
  emailTemplate,
  membership,
  smsMessage,
  smsOptOut,
  type Db,
  type DbOrTx,
} from '@repo/db';
import { can, type Actor, type MembershipRole } from '../permissions';
import { contactListQuerySchema } from '../contacts/contact-schema';
import { contactQueryFilters } from '../contacts/list-contacts';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { isPairedSkillOn } from '../skill-switches/switches';
import { toAuE164, webhookUrl } from '../phone/format';
import { agencyTwilio, providerFailure, type PhoneDeps } from '../phone/setup';
import {
  activeNumber,
  AUTO_TEXT_KINDS,
  autoTextsToCallerToday,
  BULK_TEXT_KIND,
  fromNumberFor,
  inSmsHours,
  loadSmsRules,
  nextSmsTime,
  smsDevAllowlist,
  smsSkipReason,
  textsFromNumberToday,
  type SmsSkipReason,
} from '../phone/sms-rules';
import { BATCH_TTL_MS, listingFieldsUsed, renderMerge } from './schema';
import { listingSnapshotFor } from './listing-values';
import { mayUseTemplate, TemplateEmailError } from './templates';
import { hasMarketingConsentSql } from './consent';
import { mergeValuesFor, MAX_PICKED_CONTACTS, type FilterSnapshot, type TemplateSnapshot } from './batches';
import { withStopFooter } from './sms';

/**
 * SMS batches (ADR 0074 part 2): Bulk SMS, "Text them" on a listing's Matching buyers tab, and the workflow
 * step "Send SMS". The same life as a Bulk email batch (ADR 0022) — Prepare freezes who, from which number and
 * the words; Approve claims it once; sending claims one person at a time and checks every rule again, and may
 * only ever remove someone. Stored in `email_batch` with `channel = 'sms'`, so every email path (which asks for
 * `email`) never touches one.
 *
 * The five rules live in `phone/sms-rules.ts`. Network calls (Twilio) run outside every transaction.
 */

/** Rule 5's companion: 20 people a batch, as Bulk email. */
export const SMS_BATCH_MAX = 20;

export type SmsPrepareInput = (
  | { templateId: string; filterId: string }
  | { templateId: string; contactIds: string[] }
) & {
  /** Prepared from a listing's Matching buyers tab: its merge values are frozen into the batch (ADR 0060). */
  listingId?: string;
  /** A workflow's "Send SMS" step: an automatic text (rule 4 counts it; the pair skill is checked at send). */
  workflowName?: string;
};

/** The filter snapshot of an SMS batch also says whether its texts are automatic (a workflow's). */
export type SmsFilterSnapshot = FilterSnapshot & { auto?: boolean };

export type SmsRecipient = {
  contactId: string;
  name: string;
  phone: string | null;
  phoneNumberId: string | null;
  fromE164: string | null;
  status: 'queued' | 'skipped';
  skipReason: SmsSkipReason | null;
};

export type ClassifiedSms = {
  agencyId: string;
  template: { id: string; name: string; body: string };
  filter: { id: string; name: string; query: unknown } | null;
  picked: string[] | null;
  query: unknown;
  recipients: SmsRecipient[];
  listing: Awaited<ReturnType<typeof listingSnapshotFor>> | null;
  auto: boolean;
  workflowName: string | null;
};

const truthy = (v: unknown) => v === true || v === 't';

/** Who an SMS batch would go to, classified, from which number — before anything is stored. */
export async function classifySmsRecipients(db: DbOrTx, actor: Actor, input: SmsPrepareInput, env: NodeJS.ProcessEnv = process.env): Promise<ClassifiedSms> {
  if (!actor.agencyId || !can(actor, 'email_batch:create', { type: 'email_batch', agencyId: actor.agencyId })) {
    throw new TemplateEmailError('forbidden', 'You cannot prepare bulk texts');
  }
  const agencyId = actor.agencyId;
  const [tpl] = await db.select().from(emailTemplate).where(and(eq(emailTemplate.id, input.templateId), eq(emailTemplate.agencyId, agencyId))).limit(1);
  if (!tpl) throw new TemplateEmailError('not_found', 'That template was not found');
  if (!mayUseTemplate(actor, tpl, 'sms')) {
    throw new TemplateEmailError('not_approved', 'That is not an SMS template you can send — it is retired, an email template, or a colleague’s own');
  }
  const uses = listingFieldsUsed(tpl.body);
  if (uses.length && !input.listingId) {
    throw new TemplateEmailError('invalid', `“${tpl.name}” uses listing details (${uses.map((f) => `{{${f}}}`).join(', ')}), so it can only be sent from a listing’s Matching buyers tab.`);
  }
  const listingSnap = input.listingId ? await listingSnapshotFor(db, actor, input.listingId, uses) : null;
  const picked = 'contactIds' in input ? [...new Set(input.contactIds)] : null;
  let filter: { id: string; name: string; query: unknown } | null = null;
  if (picked) {
    if (!picked.length) throw new TemplateEmailError('invalid', 'Pick at least one contact');
    if (picked.length > MAX_PICKED_CONTACTS) throw new TemplateEmailError('invalid', `Pick at most ${MAX_PICKED_CONTACTS} contacts at once`);
    if (picked.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new TemplateEmailError('invalid', 'Those contacts were not found');
  } else {
    const filterId = (input as { filterId: string }).filterId;
    const [row] = await db
      .select()
      .from(contactFilter)
      .where(and(eq(contactFilter.id, filterId), eq(contactFilter.agencyId, agencyId), eq(contactFilter.userId, actor.userId)))
      .limit(1);
    if (!row) throw new TemplateEmailError('not_found', 'That saved filter was not found');
    filter = row;
  }

  const query = filter ? contactListQuerySchema.parse(filter.query ?? {}) : {};
  const seesAll = can(actor, 'contact:read_all', { type: 'contact', agencyId });
  const [rows, rules] = await Promise.all([
    db
      .select({
        id: contact.id,
        name: contact.name,
        phone: contact.phone,
        assignedTo: contact.assignedTo,
        archivedAt: contact.archivedAt,
        optOutAt: contact.emailOptOutAt,
        consent: hasMarketingConsentSql(),
      })
      .from(contact)
      .where(and(...contactQueryFilters(actor, { ...query, archived: 'all' }, seesAll), ...(picked ? [inArray(contact.id, picked)] : [])))
      .orderBy(asc(contact.name), asc(contact.id))
      .limit(2000),
    loadSmsRules(db, agencyId),
  ]);
  const mobiles = [...new Set(rows.map((r) => toAuE164(r.phone)).filter((v): v is string => Boolean(v)))];
  const stopped = mobiles.length
    ? new Set((await db.select({ e164: smsOptOut.e164 }).from(smsOptOut).where(and(eq(smsOptOut.agencyId, agencyId), inArray(smsOptOut.e164, mobiles)))).map((r) => r.e164))
    : new Set<string>();
  const allowed = smsDevAllowlist(env);

  let toSend = 0;
  const recipients = rows.map((r): SmsRecipient => {
    const mobile = toAuE164(r.phone);
    const from = fromNumberFor(r.assignedTo, rules.numbers, rules.agencyNumber);
    let reason = smsSkipReason({
      archived: Boolean(r.archivedAt),
      optedOut: Boolean(r.optOutAt),
      smsOptedOut: Boolean(mobile && stopped.has(mobile)),
      consent: truthy(r.consent),
      mobile,
      hasFromNumber: Boolean(from),
    });
    if (!reason && allowed && !allowed(mobile!)) reason = 'dev_allowlist';
    if (!reason) {
      if (toSend >= SMS_BATCH_MAX) reason = 'batch_limit';
      else toSend += 1;
    }
    return { contactId: r.id, name: r.name, phone: mobile, phoneNumberId: from?.id ?? null, fromE164: from?.e164 ?? null, status: reason ? 'skipped' : 'queued', skipReason: reason };
  });
  return {
    agencyId,
    template: { id: tpl.id, name: tpl.name, body: tpl.body },
    filter,
    picked,
    query,
    recipients,
    listing: listingSnap,
    auto: Boolean(input.workflowName),
    workflowName: input.workflowName ?? null,
  };
}

/** Freeze a classified list as a prepared SMS batch: the batch and every recipient, or none of them. */
export async function storePreparedSmsBatch(db: Db, actor: Actor, c: ClassifiedSms, now = new Date()): Promise<{ id: string; notFound: number }> {
  // Inside a caller's transaction (a workflow step) this is a savepoint of it.
  return db.transaction(async (tx) => {
    const filterSnapshot: SmsFilterSnapshot = c.filter
      ? { filterId: c.filter.id, name: c.filter.name, query: c.query }
      : { filterId: null, name: c.workflowName ? `Workflow “${c.workflowName}”` : `Picked contacts (${c.picked!.length})`, query: { contactIds: c.picked }, ...(c.auto ? { auto: true } : {}) };
    const [batch] = await tx
      .insert(emailBatch)
      .values({
        agencyId: c.agencyId,
        userId: actor.userId,
        channel: 'sms',
        templateId: c.template.id,
        filterId: c.filter?.id ?? null,
        templateSnapshot: { templateId: c.template.id, name: c.template.name, subject: '', body: c.template.body } satisfies TemplateSnapshot,
        filterSnapshot,
        listingId: c.listing?.listingId ?? null,
        listingSnapshot: c.listing,
        preparedAt: now,
        expiresAt: new Date(now.getTime() + BATCH_TTL_MS),
      })
      .returning({ id: emailBatch.id });
    const id = batch!.id;
    if (c.recipients.length) {
      await tx.insert(emailBatchRecipient).values(
        c.recipients.map((r) => ({ batchId: id, contactId: r.contactId, name: r.name, email: null, phone: r.phone, phoneNumberId: r.phoneNumberId, status: r.status, skipReason: r.skipReason })),
      );
    }
    return { id, notFound: c.picked ? c.picked.length - c.recipients.length : 0 };
  });
}

/** Prepare: resolve, classify, freeze. Nothing is texted. */
export async function prepareSmsBatch(db: Db, actor: Actor, input: SmsPrepareInput, now = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<{ id: string; notFound: number }> {
  const c = await classifySmsRecipients(db, actor, input, env);
  if (!c.recipients.length) throw new TemplateEmailError('invalid', c.picked ? 'None of those contacts were found' : 'Nobody matches that filter');
  return storePreparedSmsBatch(db, actor, c, now);
}

async function loadSmsBatch(db: DbOrTx, actor: Actor, id: string) {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(id)) throw new TemplateEmailError('not_found', 'That batch was not found');
  const [b] = await db.select().from(emailBatch).where(and(eq(emailBatch.id, id), eq(emailBatch.agencyId, actor.agencyId), eq(emailBatch.channel, 'sms'))).limit(1);
  if (!b || !can(actor, 'email_batch:read', { type: 'email_batch', id: b.id, agencyId: b.agencyId, ownerId: b.userId })) {
    throw new TemplateEmailError('not_found', 'That batch was not found');
  }
  return b;
}

/**
 * Approve & Send — the claim, once: only the press that moves the batch out of `prepared` gets `approved`.
 * Outside the sending hours it is still approved; the texts wait for 9 am (rule 3) and `sendsAt` says when.
 */
export async function approveSmsBatch(db: DbOrTx, actor: Actor, id: string, now = new Date()): Promise<{ result: 'approved' | 'already'; sendsAt: Date }> {
  const b = await loadSmsBatch(db, actor, id);
  if (!can(actor, 'email_batch:send', { type: 'email_batch', id: b.id, agencyId: b.agencyId, ownerId: b.userId })) {
    throw new TemplateEmailError('forbidden', 'Only the person who prepared these texts can approve and send them');
  }
  const rules = await loadSmsRules(db, b.agencyId);
  const sendsAt = nextSmsTime(now, rules.hours, rules.timeZone);
  if (b.status === 'approved_sending' || b.status === 'sent') return { result: 'already', sendsAt };
  if (b.status !== 'prepared' || new Date(b.expiresAt).getTime() <= now.getTime()) {
    if (b.status === 'prepared') {
      await db.update(emailBatch).set({ status: 'expired', updatedAt: sql`now()` }).where(and(eq(emailBatch.id, b.id), eq(emailBatch.status, 'prepared')));
    }
    throw new TemplateEmailError('expired', b.status === 'cancelled' ? 'These texts were cancelled' : 'These texts have expired — prepare them again');
  }
  const [q] = await db.select({ n: sql<string>`count(*)` }).from(emailBatchRecipient).where(and(eq(emailBatchRecipient.batchId, b.id), eq(emailBatchRecipient.status, 'queued')));
  if (!Number(q?.n ?? 0)) throw new TemplateEmailError('invalid', 'Nobody in this batch can be texted');
  const claimed = await db
    .update(emailBatch)
    .set({ status: 'approved_sending', approvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(emailBatch.id, b.id), eq(emailBatch.status, 'prepared'), gt(emailBatch.expiresAt, sql`now()`)))
    .returning({ id: emailBatch.id });
  return { result: claimed.length ? 'approved' : 'already', sendsAt };
}

// ── Sending ─────────────────────────────────────────────────────────────────

export type SmsSendDeps = { phone: PhoneDeps; env?: NodeJS.ProcessEnv };
export type SmsSendReport = { sent: number; failed: number; skipped: number; held: boolean };

type Claimed = { id: string; contact_id: string; name: string; phone: string | null; phone_number_id: string | null; sms_message_id: string | null };

async function claimNext(db: Db, batchId: string): Promise<Claimed | null> {
  const rows = await db.execute<Claimed>(sql`
    update email_batch_recipient set status = 'sending', attempts = attempts + 1, updated_at = now()
    where id = (
      select id from email_batch_recipient
      where batch_id = ${batchId} and status = 'queued'
      order by name, id limit 1
      for update skip locked
    )
    returning id, contact_id, name, phone, phone_number_id, sms_message_id
  `);
  return rows[0] ?? null;
}

async function skipAtSend(db: Db, recipientId: string, reason: SmsSkipReason): Promise<void> {
  await db.update(emailBatchRecipient).set({ status: 'skipped', skipReason: reason, skippedAtSend: true, updatedAt: sql`now()` }).where(eq(emailBatchRecipient.id, recipientId));
}

async function roleOf(db: DbOrTx, agencyId: string, userId: string): Promise<MembershipRole | null> {
  const [m] = await db.select({ role: membership.role }).from(membership).where(and(eq(membership.agencyId, agencyId), eq(membership.userId, userId), eq(membership.status, 'active'))).limit(1);
  return (m?.role as MembershipRole | undefined) ?? null;
}

/**
 * Send a claimed SMS batch. Called after Approve, after a workflow step, and by the minute tick for anything
 * left queued — so outside the sending hours it sends nothing and reports `held`. Each person is claimed on
 * their own (FOR UPDATE SKIP LOCKED): two loops never text anyone twice. A retry re-sends the SAME text row.
 */
export async function sendSmsBatch(db: Db, deps: SmsSendDeps, batchId: string, now: () => Date = () => new Date()): Promise<SmsSendReport> {
  const report: SmsSendReport = { sent: 0, failed: 0, skipped: 0, held: false };
  const [batch] = await db.select().from(emailBatch).where(eq(emailBatch.id, batchId)).limit(1);
  if (!batch || batch.channel !== 'sms' || batch.status !== 'approved_sending') return report;
  const rules = await loadSmsRules(db, batch.agencyId);
  const auto = Boolean((batch.filterSnapshot as SmsFilterSnapshot | null)?.auto);
  const kind: (typeof AUTO_TEXT_KINDS)[number] | typeof BULK_TEXT_KIND = auto ? 'workflow_sms' : BULK_TEXT_KIND;
  const tpl = batch.templateSnapshot as TemplateSnapshot;
  const values = await mergeValuesFor(db, batch);
  const env = deps.env ?? process.env;
  const allowed = smsDevAllowlist(env);
  const skillOn = new Map<string, boolean>();

  for (;;) {
    // Rule 3, checked before each person: a batch that runs into 8 pm stops there and carries on at 9.
    if (!inSmsHours(now(), rules.hours, rules.timeZone)) {
      report.held = true;
      break;
    }
    const r = await claimNext(db, batchId);
    if (!r) break;

    // The moment of sending: the contact, the number and the counts as they are NOW.
    const [c] = await db
      .select({ phone: contact.phone, archivedAt: contact.archivedAt, mergedIntoId: contact.mergedIntoId, optOutAt: contact.emailOptOutAt, consent: hasMarketingConsentSql() })
      .from(contact)
      .where(eq(contact.id, r.contact_id))
      .limit(1);
    const from = r.phone_number_id ? await activeNumber(db, batch.agencyId, r.phone_number_id) : null;
    const mobile = toAuE164(c?.phone);
    const stopped = r.phone ? (await db.select({ e164: smsOptOut.e164 }).from(smsOptOut).where(and(eq(smsOptOut.agencyId, batch.agencyId), eq(smsOptOut.e164, r.phone))).limit(1)).length > 0 : false;
    let reason: SmsSkipReason | null = !c
      ? 'archived'
      : smsSkipReason({ archived: Boolean(c.archivedAt || c.mergedIntoId), optedOut: Boolean(c.optOutAt), smsOptedOut: stopped, consent: truthy(c.consent), mobile, hasFromNumber: Boolean(from) });
    if (!reason && mobile !== r.phone) reason = 'phone_changed';
    if (!reason && allowed && !allowed(r.phone!)) reason = 'dev_allowlist';
    if (!reason && !r.sms_message_id && (await textsFromNumberToday(db, from!.id)) >= rules.perNumber) reason = 'daily_limit';
    if (!reason && auto) {
      // The pair skill (ADR 0069 §4): the agency's switch AND the switch of the agent whose number sends it.
      if (!skillOn.has(from!.userId)) skillOn.set(from!.userId, await isPairedSkillOn(db, batch.agencyId, from!.userId, await roleOf(db, batch.agencyId, from!.userId), 'workflow_texts'));
      if (!skillOn.get(from!.userId)) reason = 'skill_off';
      else if (!r.sms_message_id && (await autoTextsToCallerToday(db, batch.agencyId, r.phone!)) >= rules.autoPerCaller) reason = 'auto_limit';
    }
    if (reason) {
      await skipAtSend(db, r.id, reason);
      report.skipped += 1;
      continue;
    }

    let messageId = r.sms_message_id;
    try {
      if (messageId) {
        // A retry: the same text, sent again — never a second row.
        await db.update(smsMessage).set({ status: 'queued', error: null, updatedAt: sql`now()` }).where(and(eq(smsMessage.id, messageId), eq(smsMessage.status, 'failed')));
      } else {
        messageId = randomUUID();
        const body = withStopFooter(renderMerge(tpl.body, values(r.name)));
        await db.transaction(async (tx) => {
          await tx.insert(smsMessage).values({ id: messageId!, agencyId: batch.agencyId, phoneNumberId: from!.id, counterpart: r.phone!, contactId: r.contact_id, direction: 'out', body, status: 'queued', sentBy: batch.userId, kind });
          await tx.update(emailBatchRecipient).set({ smsMessageId: messageId, updatedAt: sql`now()` }).where(eq(emailBatchRecipient.id, r.id));
        });
      }
      const [msg] = await db.select({ body: smsMessage.body }).from(smsMessage).where(eq(smsMessage.id, messageId!)).limit(1);
      const { client } = await agencyTwilio(db, batch.agencyId, deps.phone);
      const statusUrl = deps.phone.keys && deps.phone.webhookBase ? webhookUrl(deps.phone.webhookBase, from!.id, 'sms-status', deps.phone.keys) : null;
      const sent = await client.sendSms({ from: from!.e164, to: r.phone!, body: msg!.body, statusUrl });
      await db.transaction(async (tx) => {
        await tx.update(smsMessage).set({ status: sent.status === 'sent' ? 'sent' : 'queued', providerSid: sent.sid, updatedAt: sql`now()` }).where(eq(smsMessage.id, messageId!));
        await tx.update(emailBatchRecipient).set({ status: 'sent', sentAt: sql`now()`, error: null, updatedAt: sql`now()` }).where(eq(emailBatchRecipient.id, r.id));
        await tx.insert(activity).values({
          agencyId: batch.agencyId,
          contactId: r.contact_id,
          kind: 'template_sms_sent',
          actorType: 'user',
          actorId: batch.userId,
          payload: { batchId, templateName: tpl.name, smsMessageId: messageId, auto },
        });
      });
      report.sent += 1;
    } catch (err) {
      const failure = providerFailure(err, 'Twilio refused to send with the saved key.');
      if (messageId) await db.update(smsMessage).set({ status: 'failed', error: failure.message, updatedAt: sql`now()` }).where(eq(smsMessage.id, messageId));
      await db.update(emailBatchRecipient).set({ status: 'failed', error: failure.message.slice(0, 300), updatedAt: sql`now()` }).where(eq(emailBatchRecipient.id, r.id));
      report.failed += 1;
    }
  }

  await db.execute(sql`
    update email_batch set status = 'sent', finished_at = now(), updated_at = now()
    where id = ${batchId} and status = 'approved_sending'
      and not exists (select 1 from email_batch_recipient r where r.batch_id = ${batchId} and r.status in ('queued', 'sending'))
  `);
  return report;
}

/**
 * The minute tick: approved SMS batches with people still queued — held for the sending hours, or left by a
 * crash or timeout. Not for a suspended agency, nor for a member who is no longer active.
 */
export async function resumeSmsBatches(db: Db, deps: SmsSendDeps, limit = 5, now: () => Date = () => new Date()): Promise<SmsSendReport & { batches: number }> {
  const due = await db
    .select({ id: emailBatch.id })
    .from(emailBatch)
    .where(
      and(
        eq(emailBatch.channel, 'sms'),
        eq(emailBatch.status, 'approved_sending'),
        lt(emailBatch.approvedAt, sql`now() - interval '1 minute'`),
        sql`exists (select 1 from email_batch_recipient r where r.batch_id = ${emailBatch.id} and r.status = 'queued')`,
        sql`${emailBatch.agencyId} not in ${SUSPENDED_AGENCY_IDS}`,
        sql`exists (select 1 from membership bm where bm.user_id = ${emailBatch.userId} and bm.agency_id = ${emailBatch.agencyId} and bm.status = 'active')`,
      ),
    )
    .orderBy(asc(emailBatch.approvedAt))
    .limit(limit);
  const total = { sent: 0, failed: 0, skipped: 0, held: false, batches: due.length };
  for (const b of due) {
    const r = await sendSmsBatch(db, deps, b.id, now);
    total.sent += r.sent;
    total.failed += r.failed;
    total.skipped += r.skipped;
    total.held ||= r.held;
  }
  return total;
}
