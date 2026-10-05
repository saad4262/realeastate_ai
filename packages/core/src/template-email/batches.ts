import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  agency,
  contact,
  contactFilter,
  emailBatch,
  emailBatchRecipient,
  emailTemplate,
  user,
  type Db,
  type DbOrTx,
} from '@repo/db';
import { can, type Actor, type Resource } from '../permissions';
import { contactListQuerySchema } from '../contacts/contact-schema';
import { contactQueryFilters } from '../contacts/list-contacts';
import { checkEmailLimits, type TemplateLimits } from '../email/limits';
import { BATCH_TTL_MS, renderMerge, type MergeValues, type SkipReason } from './schema';
import { TemplateEmailError } from './templates';

/**
 * Template email batches (docs/adr/0022): Prepare → Approve & Send.
 *
 * PREPARE resolves the saved filter AS THE AGENT (the directory's own rule),
 * classifies every contact — who will be sent to, who is skipped and why —
 * and freezes all of it with the template text. Nothing that changes later
 * alters that list, except the re-check at the moment of sending, which may
 * only ever remove someone.
 *
 * APPROVE claims the batch with one guarded UPDATE (`status = 'prepared'
 * AND expires_at > now()`): a second click, a second tab or a retry finds
 * it already claimed and sends nothing new. An expired batch cannot be
 * claimed at all.
 */

const owner = alias(user, 'batch_owner');

export type BatchStatus = 'prepared' | 'approved_sending' | 'sent' | 'expired' | 'cancelled';
export type RecipientStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'skipped';

export type TemplateSnapshot = { templateId: string; name: string; subject: string; body: string };
export type FilterSnapshot = { filterId: string; name: string; query: unknown };

function batchResource(b: { id: string; agencyId: string; userId: string }): Resource {
  return { type: 'email_batch', id: b.id, agencyId: b.agencyId, ownerId: b.userId };
}

/** The repeat window: a template email to this contact in the last N days, queued or sent. */
function recentlyEmailedSql(contactIdExpr: unknown, days: number, exceptMessageId?: string | null) {
  return sql<boolean>`exists (
    select 1 from mail_message m join mail_thread t on t.id = m.thread_id
    where t.contact_id = ${contactIdExpr} and m.kind = 'template_email'
      and m.status in ('queued', 'sent')
      and m.created_at > now() - make_interval(days => ${days})
      ${exceptMessageId ? sql`and m.id <> ${exceptMessageId}` : sql``}
  )`;
}

/** The order the skip reasons are tested in — the first that applies is the one shown. */
function classify(c: {
  archived: boolean;
  optedOut: boolean;
  consent: boolean;
  email: string | null;
  recently: boolean;
}): SkipReason | null {
  if (c.archived) return 'archived';
  if (c.optedOut) return 'opted_out';
  if (!c.consent) return 'no_consent';
  if (!c.email) return 'no_email';
  if (c.recently) return 'recently_emailed';
  return null;
}

const truthy = (v: unknown) => v === true || v === 't';

/** Prepare: resolve, classify, freeze. Nothing is sent. */
export async function prepareBatch(
  db: Db,
  actor: Actor,
  input: { templateId: string; filterId: string },
  limits: TemplateLimits,
  now = new Date(),
): Promise<{ id: string }> {
  if (!actor.agencyId || !can(actor, 'email_batch:create', { type: 'email_batch', agencyId: actor.agencyId })) {
    throw new TemplateEmailError('forbidden', 'You cannot prepare bulk email');
  }
  const agencyId = actor.agencyId;
  const [tpl] = await db
    .select()
    .from(emailTemplate)
    .where(and(eq(emailTemplate.id, input.templateId), eq(emailTemplate.agencyId, agencyId)))
    .limit(1);
  if (!tpl) throw new TemplateEmailError('not_found', 'That template was not found');
  if (tpl.status !== 'approved') {
    throw new TemplateEmailError('not_approved', 'Only an approved template can be used — ask an owner or admin to approve it');
  }
  const [filter] = await db
    .select()
    .from(contactFilter)
    .where(and(eq(contactFilter.id, input.filterId), eq(contactFilter.agencyId, agencyId), eq(contactFilter.userId, actor.userId)))
    .limit(1);
  if (!filter) throw new TemplateEmailError('not_found', 'That saved filter was not found');

  const query = contactListQuerySchema.parse(filter.query ?? {});
  const seesAll = can(actor, 'contact:read_all', { type: 'contact', agencyId });
  // Archived people are resolved too — so they can be SHOWN as skipped.
  const rows = await db
    .select({
      id: contact.id,
      name: contact.name,
      email: contact.email,
      archivedAt: contact.archivedAt,
      optOutAt: contact.emailOptOutAt,
      consentAt: contact.marketingConsentAt,
      // Qualified by hand: a single-table select renders its columns as a bare "id", which the subquery's own tables would make ambiguous.
      recently: recentlyEmailedSql(sql.raw('"contact"."id"'), limits.repeatDays),
    })
    .from(contact)
    .where(and(...contactQueryFilters(actor, { ...query, archived: 'all' }, seesAll)))
    .orderBy(asc(contact.name), asc(contact.id))
    .limit(2000);
  if (!rows.length) throw new TemplateEmailError('invalid', 'Nobody matches that filter');

  let toSend = 0;
  const recipients = rows.map((r) => {
    let reason = classify({
      archived: Boolean(r.archivedAt),
      optedOut: Boolean(r.optOutAt),
      consent: Boolean(r.consentAt),
      email: r.email,
      recently: truthy(r.recently),
    });
    if (!reason) {
      if (toSend >= limits.perBatch) reason = 'batch_limit';
      else toSend += 1;
    }
    return { contactId: r.id, name: r.name, email: r.email, status: (reason ? 'skipped' : 'queued') as RecipientStatus, skipReason: reason };
  });

  return db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(emailBatch)
      .values({
        agencyId,
        userId: actor.userId,
        templateId: tpl.id,
        filterId: filter.id,
        templateSnapshot: { templateId: tpl.id, name: tpl.name, subject: tpl.subject, body: tpl.body } satisfies TemplateSnapshot,
        filterSnapshot: { filterId: filter.id, name: filter.name, query } satisfies FilterSnapshot,
        preparedAt: now,
        expiresAt: new Date(now.getTime() + BATCH_TTL_MS),
      })
      .returning({ id: emailBatch.id });
    const id = batch!.id;
    for (let i = 0; i < recipients.length; i += 500) {
      await tx.insert(emailBatchRecipient).values(recipients.slice(i, i + 500).map((r) => ({ ...r, batchId: id })));
    }
    return { id };
  });
}

export type RecipientView = {
  id: string;
  contactId: string;
  name: string;
  email: string | null;
  status: RecipientStatus;
  skipReason: SkipReason | null;
  skippedAtSend: boolean;
  threadId: string | null;
  error: string | null;
  sentAt: Date | null;
};

export type BatchCounts = { total: number; toSend: number; skipped: number; sent: number; failed: number; sending: number };

export type BatchView = {
  id: string;
  agentId: string;
  agentName: string | null;
  status: BatchStatus;
  template: TemplateSnapshot;
  filter: FilterSnapshot;
  preparedAt: Date;
  expiresAt: Date;
  approvedAt: Date | null;
  finishedAt: Date | null;
  counts: BatchCounts;
  recipients: RecipientView[];
  /** The email as the first recipient would get it — from the frozen template. */
  preview: { to: string | null; subject: string; body: string } | null;
  mayApprove: boolean;
  mayCancel: boolean;
  mayRetry: boolean;
};

const COUNTS = {
  total: sql<string>`(select count(*) from email_batch_recipient r where r.batch_id = ${emailBatch.id})`,
  toSend: sql<string>`(select count(*) from email_batch_recipient r where r.batch_id = ${emailBatch.id} and r.status = 'queued')`,
  skipped: sql<string>`(select count(*) from email_batch_recipient r where r.batch_id = ${emailBatch.id} and r.status = 'skipped')`,
  sent: sql<string>`(select count(*) from email_batch_recipient r where r.batch_id = ${emailBatch.id} and r.status = 'sent')`,
  failed: sql<string>`(select count(*) from email_batch_recipient r where r.batch_id = ${emailBatch.id} and r.status = 'failed')`,
  sending: sql<string>`(select count(*) from email_batch_recipient r where r.batch_id = ${emailBatch.id} and r.status = 'sending')`,
};

function counts(r: Record<string, unknown>): BatchCounts {
  return {
    total: Number(r.total ?? 0),
    toSend: Number(r.toSend ?? 0),
    skipped: Number(r.skipped ?? 0),
    sent: Number(r.sent ?? 0),
    failed: Number(r.failed ?? 0),
    sending: Number(r.sending ?? 0),
  };
}

/** A prepared batch past its 48 hours reads as expired, whether or not the tick has marked it yet. */
function effectiveStatus(status: string, expiresAt: Date, now: Date): BatchStatus {
  return status === 'prepared' && expiresAt.getTime() <= now.getTime() ? 'expired' : (status as BatchStatus);
}

export async function mergeValuesFor(db: DbOrTx, batch: { agencyId: string; userId: string }) {
  const [who] = await db
    .select({ agentName: user.name, agentEmail: user.email, agencyName: agency.name })
    .from(user)
    .innerJoin(agency, eq(agency.id, batch.agencyId))
    .where(eq(user.id, batch.userId))
    .limit(1);
  return (name: string): MergeValues => ({
    first_name: name.trim().split(/\s+/)[0] || name,
    full_name: name,
    agent_name: who?.agentName || who?.agentEmail || 'your agent',
    agency_name: who?.agencyName || 'the agency',
  });
}

/** One batch, if this actor may see it (its agent, or an admin). Not-found otherwise. */
export async function getBatch(db: Db, actor: Actor, id: string, now = new Date()): Promise<BatchView> {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(id)) throw new TemplateEmailError('not_found', 'That batch was not found');
  const [b] = await db
    .select({
      id: emailBatch.id,
      agencyId: emailBatch.agencyId,
      userId: emailBatch.userId,
      agentName: owner.name,
      status: emailBatch.status,
      templateSnapshot: emailBatch.templateSnapshot,
      filterSnapshot: emailBatch.filterSnapshot,
      preparedAt: emailBatch.preparedAt,
      expiresAt: emailBatch.expiresAt,
      approvedAt: emailBatch.approvedAt,
      finishedAt: emailBatch.finishedAt,
      ...COUNTS,
    })
    .from(emailBatch)
    .leftJoin(owner, eq(owner.id, emailBatch.userId))
    .where(and(eq(emailBatch.id, id), eq(emailBatch.agencyId, actor.agencyId)))
    .limit(1);
  if (!b || !can(actor, 'email_batch:read', batchResource(b))) throw new TemplateEmailError('not_found', 'That batch was not found');

  const recipients = await db
    .select()
    .from(emailBatchRecipient)
    .where(eq(emailBatchRecipient.batchId, b.id))
    .orderBy(asc(emailBatchRecipient.status), asc(emailBatchRecipient.name));

  const status = effectiveStatus(b.status, new Date(b.expiresAt), now);
  const tpl = b.templateSnapshot as TemplateSnapshot;
  const first = recipients.find((r) => r.status === 'queued') ?? recipients[0];
  const values = await mergeValuesFor(db, b);
  const res = batchResource(b);
  const c = counts(b);
  return {
    id: b.id,
    agentId: b.userId,
    agentName: b.agentName,
    status,
    template: tpl,
    filter: b.filterSnapshot as FilterSnapshot,
    preparedAt: new Date(b.preparedAt),
    expiresAt: new Date(b.expiresAt),
    approvedAt: b.approvedAt ? new Date(b.approvedAt) : null,
    finishedAt: b.finishedAt ? new Date(b.finishedAt) : null,
    counts: c,
    recipients: recipients.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      name: r.name,
      email: r.email,
      status: r.status as RecipientStatus,
      skipReason: (r.skipReason as SkipReason | null) ?? null,
      skippedAtSend: r.skippedAtSend,
      threadId: r.threadId,
      error: r.error,
      sentAt: r.sentAt ? new Date(r.sentAt) : null,
    })),
    preview: first
      ? { to: first.email, subject: renderMerge(tpl.subject, values(first.name)), body: renderMerge(tpl.body, values(first.name)) }
      : null,
    mayApprove: status === 'prepared' && c.toSend > 0 && can(actor, 'email_batch:send', res),
    mayCancel: status === 'prepared' && can(actor, 'email_batch:cancel', res),
    mayRetry: (status === 'sent' || status === 'approved_sending') && c.failed > 0 && can(actor, 'email_batch:send', res),
  };
}

export type BatchRow = {
  id: string;
  agentName: string | null;
  templateName: string;
  filterName: string;
  status: BatchStatus;
  preparedAt: Date;
  expiresAt: Date;
  counts: BatchCounts;
};

/** The actor's batches — or, for an admin, the agency's. One query. */
export async function listBatches(db: Db, actor: Actor, now = new Date()): Promise<BatchRow[]> {
  if (!actor.agencyId || !can(actor, 'email_batch:read', { type: 'email_batch', agencyId: actor.agencyId })) {
    throw new TemplateEmailError('forbidden', 'You do not have permission to view bulk email');
  }
  const admin = can(actor, 'email_template:approve', { type: 'email_template', agencyId: actor.agencyId });
  const rows = await db
    .select({
      id: emailBatch.id,
      agentName: owner.name,
      templateSnapshot: emailBatch.templateSnapshot,
      filterSnapshot: emailBatch.filterSnapshot,
      status: emailBatch.status,
      preparedAt: emailBatch.preparedAt,
      expiresAt: emailBatch.expiresAt,
      ...COUNTS,
    })
    .from(emailBatch)
    .leftJoin(owner, eq(owner.id, emailBatch.userId))
    .where(and(eq(emailBatch.agencyId, actor.agencyId), admin ? sql`true` : eq(emailBatch.userId, actor.userId)))
    .orderBy(desc(emailBatch.preparedAt))
    .limit(100);
  return rows.map((r) => ({
    id: r.id,
    agentName: r.agentName,
    templateName: (r.templateSnapshot as TemplateSnapshot).name,
    filterName: (r.filterSnapshot as FilterSnapshot).name,
    status: effectiveStatus(r.status, new Date(r.expiresAt), now),
    preparedAt: new Date(r.preparedAt),
    expiresAt: new Date(r.expiresAt),
    counts: counts(r),
  }));
}

async function loadForWrite(db: Db, actor: Actor, id: string) {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(id)) throw new TemplateEmailError('not_found', 'That batch was not found');
  const [b] = await db
    .select()
    .from(emailBatch)
    .where(and(eq(emailBatch.id, id), eq(emailBatch.agencyId, actor.agencyId)))
    .limit(1);
  if (!b || !can(actor, 'email_batch:read', batchResource(b))) throw new TemplateEmailError('not_found', 'That batch was not found');
  return b;
}

/**
 * Approve & Send — the claim. Idempotent: only the click that moves the batch
 * out of `prepared` gets `approved`; any other gets `already` and sends
 * nothing new. Over a daily limit, nothing is claimed and nothing is sent.
 */
export async function approveBatch(
  db: Db,
  actor: Actor,
  id: string,
  limits: TemplateLimits,
  now = new Date(),
): Promise<{ result: 'approved' | 'already' }> {
  const b = await loadForWrite(db, actor, id);
  if (!can(actor, 'email_batch:send', batchResource(b))) {
    throw new TemplateEmailError('forbidden', 'Only the agent who prepared this batch can approve and send it');
  }
  if (b.status === 'approved_sending' || b.status === 'sent') return { result: 'already' };
  if (b.status !== 'prepared' || new Date(b.expiresAt).getTime() <= now.getTime()) {
    if (b.status === 'prepared') {
      await db.update(emailBatch).set({ status: 'expired', updatedAt: sql`now()` }).where(and(eq(emailBatch.id, b.id), eq(emailBatch.status, 'prepared')));
    }
    throw new TemplateEmailError('expired', b.status === 'cancelled' ? 'This batch was cancelled' : 'This batch has expired — prepare it again');
  }
  const [q] = await db
    .select({ n: sql<string>`count(*)` })
    .from(emailBatchRecipient)
    .where(and(eq(emailBatchRecipient.batchId, b.id), eq(emailBatchRecipient.status, 'queued')));
  const toSend = Number(q?.n ?? 0);
  if (!toSend) throw new TemplateEmailError('invalid', 'Nobody in this batch can be sent to');
  const check = await checkEmailLimits(db, { agencyId: b.agencyId, userId: b.userId }, limits, toSend);
  if (!check.ok) throw new TemplateEmailError('limit', `${check.reason} Nothing was sent.`);

  const claimed = await db
    .update(emailBatch)
    .set({ status: 'approved_sending', approvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(emailBatch.id, b.id), eq(emailBatch.status, 'prepared'), gt(emailBatch.expiresAt, sql`now()`)))
    .returning({ id: emailBatch.id });
  return { result: claimed.length ? 'approved' : 'already' };
}

export async function cancelBatch(db: Db, actor: Actor, id: string): Promise<void> {
  const b = await loadForWrite(db, actor, id);
  if (!can(actor, 'email_batch:cancel', batchResource(b))) throw new TemplateEmailError('forbidden', 'You may not cancel this batch');
  const done = await db
    .update(emailBatch)
    .set({ status: 'cancelled', cancelledAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(emailBatch.id, b.id), eq(emailBatch.status, 'prepared')))
    .returning({ id: emailBatch.id });
  if (!done.length) throw new TemplateEmailError('conflict', 'Only a prepared batch can be cancelled');
}

/** Put the FAILED recipients back in the queue — never the sent or skipped ones. */
export async function retryFailed(db: Db, actor: Actor, id: string): Promise<{ requeued: number }> {
  const b = await loadForWrite(db, actor, id);
  if (!can(actor, 'email_batch:send', batchResource(b))) throw new TemplateEmailError('forbidden', 'Only the agent who sent this batch can retry it');
  if (b.status !== 'sent' && b.status !== 'approved_sending') throw new TemplateEmailError('conflict', 'Only a sent batch can be retried');
  return db.transaction(async (tx) => {
    const requeued = await tx
      .update(emailBatchRecipient)
      .set({ status: 'queued', error: null, updatedAt: sql`now()` })
      .where(and(eq(emailBatchRecipient.batchId, b.id), eq(emailBatchRecipient.status, 'failed')))
      .returning({ id: emailBatchRecipient.id });
    if (requeued.length) {
      await tx.update(emailBatch).set({ status: 'approved_sending', finishedAt: null, updatedAt: sql`now()` }).where(eq(emailBatch.id, b.id));
    }
    return { requeued: requeued.length };
  });
}

/** The tick's housekeeping: prepared batches past 48 h become `expired`. */
export async function expirePreparedBatches(db: Db, now = new Date()): Promise<number> {
  const done = await db
    .update(emailBatch)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(and(eq(emailBatch.status, 'prepared'), lte(emailBatch.expiresAt, now)))
    .returning({ id: emailBatch.id });
  return done.length;
}

export { recentlyEmailedSql, classify };
