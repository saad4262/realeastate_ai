import { and, eq, lt, sql } from 'drizzle-orm';
import {
  activity,
  contact,
  emailBatch,
  emailBatchRecipient,
  mailMessage,
  mailThread,
  skill,
  type Db,
} from '@repo/db';
import { checkEmailLimits, devAllowlist, emailLimitsFromEnv, type TemplateLimits } from '../email/limits';
import { contactUnsubscribeUrl } from '../email/unsubscribe';
import { deliverOutbound, mailDepsFromEnv, recordOutbound, type MailDeps } from '../mail/send';
import { mergeValuesFor, classify, type TemplateSnapshot } from './batches';
import { hasMarketingConsentSql } from './consent';
import { renderMerge, type SkipReason } from './schema';

/**
 * Sending a claimed batch (docs/adr/0022). Called right after Approve, and by
 * the cron tick for any batch left with queued recipients.
 *
 * Never double-sends. Each recipient is CLAIMED on its own — `queued` →
 * `sending` with FOR UPDATE SKIP LOCKED — so two loops (a double click, a
 * tick overlapping an approve) each take different people, and nobody is
 * taken twice. Sent and skipped recipients are never queued again; a retry
 * re-queues only `failed` ones, and re-delivers their existing message
 * rather than writing a second one.
 *
 * Re-checked at the moment of sending, per recipient: archived, opted out,
 * consent (recorded or inferred, ADR 0043), the address still the one frozen
 * at Prepare, the development allowlist, the daily limits. Each may only
 * REMOVE someone; nobody is added after Prepare.
 *
 * Network calls (the mail provider) run outside every transaction.
 */

export type TemplateSendDeps = {
  mail: MailDeps;
  /** The public site and the unsubscribe secret — the link in every email. */
  unsubscribe: { baseUrl: string; secret: string };
  limits: TemplateLimits;
  env?: NodeJS.ProcessEnv;
  /** Test seam for the pause between messages. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Claimed = {
  id: string;
  contact_id: string;
  name: string;
  email: string | null;
  thread_id: string | null;
  mail_message_id: string | null;
};

async function claimNext(db: Db, batchId: string): Promise<Claimed | null> {
  const rows = await db.execute<Claimed>(sql`
    update email_batch_recipient set status = 'sending', attempts = attempts + 1, updated_at = now()
    where id = (
      select id from email_batch_recipient
      where batch_id = ${batchId} and status = 'queued'
      order by name, id limit 1
      for update skip locked
    )
    returning id, contact_id, name, email, thread_id, mail_message_id
  `);
  return rows[0] ?? null;
}

async function skipAtSend(db: Db, recipientId: string, reason: SkipReason): Promise<void> {
  await db
    .update(emailBatchRecipient)
    .set({ status: 'skipped', skipReason: reason, skippedAtSend: true, updatedAt: sql`now()` })
    .where(eq(emailBatchRecipient.id, recipientId));
}

export type SendReport = { sent: number; failed: number; skipped: number };

export async function sendBatch(db: Db, deps: TemplateSendDeps, batchId: string): Promise<SendReport> {
  const report: SendReport = { sent: 0, failed: 0, skipped: 0 };
  const [batch] = await db.select().from(emailBatch).where(eq(emailBatch.id, batchId)).limit(1);
  if (!batch || batch.status !== 'approved_sending') return report;
  const tpl = batch.templateSnapshot as TemplateSnapshot;
  const values = await mergeValuesFor(db, batch);
  const allowed = devAllowlist(deps.env ?? process.env);
  const sleep = deps.sleep ?? defaultSleep;
  let first = true;

  for (;;) {
    const r = await claimNext(db, batchId);
    if (!r) break;

    // The moment of sending: look at the contact as it is NOW.
    const [now] = await db
      .select({
        email: contact.email,
        archivedAt: contact.archivedAt,
        mergedIntoId: contact.mergedIntoId,
        optOutAt: contact.emailOptOutAt,
        // The same definition as at Prepare (ADR 0043): recorded, or inferred — and the opt-out tested first.
        consent: hasMarketingConsentSql(),
      })
      .from(contact)
      .where(eq(contact.id, r.contact_id))
      .limit(1);
    let reason: SkipReason | null = !now
      ? 'archived'
      : classify({
          archived: Boolean(now.archivedAt || now.mergedIntoId),
          optedOut: Boolean(now.optOutAt),
          consent: now.consent === true || (now.consent as unknown) === 't',
          email: now.email,
        });
    if (!reason && (now?.email ?? '').toLowerCase() !== (r.email ?? '').toLowerCase()) reason = 'email_changed';
    if (!reason && allowed && !allowed(r.email ?? '')) reason = 'dev_allowlist';
    if (!reason) {
      const limit = await checkEmailLimits(db, { agencyId: batch.agencyId, userId: batch.userId }, deps.limits, r.mail_message_id ? 0 : 1);
      if (!limit.ok) reason = 'daily_limit';
    }
    if (reason) {
      await skipAtSend(db, r.id, reason);
      report.skipped += 1;
      continue;
    }

    if (!first && deps.limits.sendDelayMs > 0) await sleep(deps.limits.sendDelayMs);
    first = false;

    let messageId = r.mail_message_id;
    let threadId = r.thread_id;
    try {
      if (messageId) {
        // A retry: the same message, delivered again — never a second one.
        await db.update(mailMessage).set({ status: 'queued', error: null, updatedAt: sql`now()` })
          .where(and(eq(mailMessage.id, messageId), eq(mailMessage.status, 'failed')));
      } else {
        const v = values(r.name);
        const subject = renderMerge(tpl.subject, v);
        const body = renderMerge(tpl.body, v);
        const created = await db.transaction(async (tx) => {
          const [thread] = await tx
            .insert(mailThread)
            .values({ agencyId: batch.agencyId, contactId: r.contact_id, subject, contactEmail: r.email!.toLowerCase(), contactName: r.name })
            .returning({ id: mailThread.id });
          const id = await recordOutbound(tx as unknown as Db, deps.mail, {
            threadId: thread!.id,
            agencyId: batch.agencyId,
            subject,
            to: r.email!,
            body,
            sentBy: batch.userId,
            channel: 'console',
            kind: 'template_email',
          });
          await tx
            .update(emailBatchRecipient)
            .set({ threadId: thread!.id, mailMessageId: id, updatedAt: sql`now()` })
            .where(eq(emailBatchRecipient.id, r.id));
          return { threadId: thread!.id, messageId: id };
        });
        messageId = created.messageId;
        threadId = created.threadId;
      }

      // The same environment the allowlist above was read from, for the shared backstop.
      const outcome = await deliverOutbound(db, { ...deps.mail, env: deps.env ?? deps.mail.env }, messageId!, {
        unsubscribeUrl: contactUnsubscribeUrl(deps.unsubscribe.baseUrl, r.contact_id, deps.unsubscribe.secret),
      });

      if (outcome.status === 'sent') {
        await db.transaction(async (tx) => {
          await tx
            .update(emailBatchRecipient)
            .set({ status: 'sent', sentAt: sql`now()`, error: null, updatedAt: sql`now()` })
            .where(eq(emailBatchRecipient.id, r.id));
          await tx.insert(activity).values({
            agencyId: batch.agencyId,
            contactId: r.contact_id,
            kind: 'template_email_sent',
            actorType: 'user',
            actorId: batch.userId,
            payload: { batchId, templateName: tpl.name, messageId, threadId },
          });
        });
        report.sent += 1;
      } else if (outcome.status === 'sending') {
        // Another delivery holds this message (ADR 0039 Phase 1): leave the recipient as it is —
        // the stuck-recipient recovery picks it up, and the provider key keeps it to one email.
      } else {
        await db
          .update(emailBatchRecipient)
          .set({ status: 'failed', error: (outcome.error ?? 'Not delivered').slice(0, 300), updatedAt: sql`now()` })
          .where(eq(emailBatchRecipient.id, r.id));
        report.failed += 1;
      }
    } catch (err) {
      await db
        .update(emailBatchRecipient)
        .set({ status: 'failed', error: err instanceof Error ? err.message.slice(0, 300) : 'Could not send', updatedAt: sql`now()` })
        .where(eq(emailBatchRecipient.id, r.id));
      report.failed += 1;
    }
  }

  // Finished when nobody is left queued or mid-send.
  await db.execute(sql`
    update email_batch set status = 'sent', finished_at = now(), updated_at = now()
    where id = ${batchId} and status = 'approved_sending'
      and not exists (select 1 from email_batch_recipient r where r.batch_id = ${batchId} and r.status in ('queued', 'sending'))
  `);
  return report;
}

/**
 * Recipients stuck mid-send (a crash between claim and outcome) for over ten
 * minutes: the message's own status decides. Sent → sent. Anything else →
 * failed, with a note, so a person looks before retrying.
 */
export async function recoverStuckRecipients(db: Db): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    update email_batch_recipient r set
      status = case when m.status = 'sent' then 'sent'::email_recipient_status else 'failed'::email_recipient_status end,
      error = case when m.status = 'sent' then null else 'Interrupted while sending — check the conversation before retrying' end,
      sent_at = case when m.status = 'sent' then coalesce(r.sent_at, now()) else r.sent_at end,
      updated_at = now()
    from (select r2.id, mm.status from email_batch_recipient r2 left join mail_message mm on mm.id = r2.mail_message_id
          where r2.status = 'sending' and r2.updated_at < now() - interval '10 minutes') m
    where r.id = m.id
    returning r.id
  `);
  return rows.length;
}

/** Batches approved but left with queued recipients (a crash, a timeout): carry on. */
export async function resumeSendingBatches(db: Db, deps: TemplateSendDeps): Promise<SendReport> {
  const due = await db
    .select({ id: emailBatch.id })
    .from(emailBatch)
    .where(
      and(
        eq(emailBatch.status, 'approved_sending'),
        lt(emailBatch.approvedAt, sql`now() - interval '2 minutes'`),
        sql`exists (select 1 from email_batch_recipient r where r.batch_id = ${emailBatch.id} and r.status = 'queued')`,
      ),
    )
    .limit(5);
  const total: SendReport = { sent: 0, failed: 0, skipped: 0 };
  for (const b of due) {
    const r = await sendBatch(db, deps, b.id);
    total.sent += r.sent;
    total.failed += r.failed;
    total.skipped += r.skipped;
  }
  return total;
}

/**
 * A contact's unsubscribe link (the `c.` token, verified by the caller):
 * opted out from now, as a dated fact, with a timeline entry. Idempotent —
 * a second click changes nothing and still says "you are unsubscribed".
 */
export async function optOutContact(db: Db, contactId: string): Promise<{ ok: boolean }> {
  return db.transaction(async (tx) => {
    const done = await tx
      .update(contact)
      .set({ emailOptOutAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(contact.id, contactId), sql`${contact.emailOptOutAt} is null`))
      .returning({ id: contact.id, agencyId: contact.agencyId });
    if (done[0]) {
      await tx.insert(activity).values({
        agencyId: done[0].agencyId,
        contactId,
        kind: 'contact_opted_out',
        actorType: 'system',
        payload: { via: 'unsubscribe link' },
      });
      return { ok: true };
    }
    const [exists] = await tx.select({ id: contact.id }).from(contact).where(eq(contact.id, contactId)).limit(1);
    return { ok: Boolean(exists) };
  });
}

/**
 * The library entry for the template email (ADR 0022 + the user's step 5).
 * Created here rather than in migration 0026: a new enum value cannot be used
 * in the same migration transaction that adds it. Idempotent — one cheap
 * INSERT … ON CONFLICT DO NOTHING; the unique (scope, slug) index decides.
 */
export async function ensureTemplateEmailSkill(db: Db): Promise<void> {
  await db
    .insert(skill)
    .values({
      slug: 'template-email',
      name: 'Template email to contacts',
      description:
        'Send a template to the contacts in one of your saved filters — people who agreed to marketing email, enquired in the last 24 months, or are clients; never anyone who unsubscribed. Prepare, check every name, then Approve & Send. Never on a schedule.',
      handler: 'template_email',
      bodyMd:
        '---\nrequires: []\nmodel: summary\n---\n\nNo AI writes this email: it is a template a person wrote, with merge fields.\nUse it from Bulk email: Prepare, check the list, Approve & Send.\nNeeds each contact to have marketing consent recorded.\n',
      requires: [],
      modelTier: 'summary',
    })
    .onConflictDoNothing();
}



/**
 * Everything sending needs, from the environment — or null with the reason
 * when it cannot send: no mail provider, or no unsubscribe secret (a
 * marketing email without a working unsubscribe is not sent, Spam Act s.18).
 */
export function templateSendDepsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; deps: TemplateSendDeps } | { ok: false; reason: string } {
  const mail = mailDepsFromEnv(env);
  if (!mail) return { ok: false, reason: 'Email is not set up on this server (Resend and the sender identity).' };
  const secret = env.ALERT_UNSUBSCRIBE_SECRET?.trim();
  if (!secret) return { ok: false, reason: 'ALERT_UNSUBSCRIBE_SECRET is not set — a marketing email must carry a working unsubscribe link.' };
  const baseUrl = env.NEXT_PUBLIC_WEB_URL?.trim() || 'http://web.lvh.me:3000';
  return { ok: true, deps: { mail, unsubscribe: { baseUrl, secret }, limits: emailLimitsFromEnv(env), env } };
}
