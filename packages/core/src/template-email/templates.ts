import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { contactFilter, emailTemplate, user, type Db } from '@repo/db';
import { can, type Actor, type Resource } from '../permissions';
import { contactListQuerySchema, type ContactListQuery } from '../contacts/contact-schema';
import { templateInputSchema, type TemplateInput } from './schema';

/**
 * Email templates and saved filters (docs/adr/0022). Anyone who may write
 * drafts a template; only an owner/admin approves one; only an approved one
 * can be sent. An approved template is never edited — retire it and write a
 * new one, so a sent email always traces to the text that was approved.
 */

export class TemplateEmailError extends Error {
  readonly code: 'forbidden' | 'not_found' | 'invalid' | 'conflict' | 'expired' | 'limit' | 'not_approved' | 'unavailable';
  constructor(code: TemplateEmailError['code'], message: string) {
    super(message);
    this.name = 'TemplateEmailError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f-]{36}$/i;
const author = alias(user, 'author');
const approver = alias(user, 'approver');

export type TemplateStatus = 'draft' | 'pending_approval' | 'approved' | 'retired';

export type TemplateView = {
  id: string;
  name: string;
  subject: string;
  body: string;
  status: TemplateStatus;
  authorName: string | null;
  approvedByName: string | null;
  approvedAt: Date | null;
  updatedAt: Date;
  mayEdit: boolean;
  maySubmit: boolean;
  mayApprove: boolean;
};

function templateResource(t: { id: string; agencyId: string; createdBy: string | null }): Resource {
  return { type: 'email_template', id: t.id, agencyId: t.agencyId, ...(t.createdBy ? { ownerId: t.createdBy } : {}) };
}

/**
 * The templates this actor may see: approved ones for everyone; drafts and
 * pending ones to their author and to admins. Retired are hidden. One query.
 */
export async function listTemplates(db: Db, actor: Actor): Promise<{ templates: TemplateView[]; mayDraft: boolean }> {
  if (!actor.agencyId || !can(actor, 'email_template:read', { type: 'email_template', agencyId: actor.agencyId })) {
    throw new TemplateEmailError('forbidden', 'You do not have permission to view templates');
  }
  const admin = can(actor, 'email_template:approve', { type: 'email_template', agencyId: actor.agencyId });
  const rows = await db
    .select({
      id: emailTemplate.id,
      agencyId: emailTemplate.agencyId,
      name: emailTemplate.name,
      subject: emailTemplate.subject,
      body: emailTemplate.body,
      status: emailTemplate.status,
      createdBy: emailTemplate.createdBy,
      authorName: author.name,
      approvedByName: approver.name,
      approvedAt: emailTemplate.approvedAt,
      updatedAt: emailTemplate.updatedAt,
    })
    .from(emailTemplate)
    .leftJoin(author, eq(author.id, emailTemplate.createdBy))
    .leftJoin(approver, eq(approver.id, emailTemplate.approvedBy))
    .where(
      and(
        eq(emailTemplate.agencyId, actor.agencyId),
        ne(emailTemplate.status, 'retired'),
        admin ? sql`true` : or(eq(emailTemplate.status, 'approved'), eq(emailTemplate.createdBy, actor.userId))!,
      ),
    )
    .orderBy(desc(emailTemplate.updatedAt));
  return {
    templates: rows.map((r) => {
      const res = templateResource(r);
      return {
        id: r.id,
        name: r.name,
        subject: r.subject,
        body: r.body,
        status: r.status as TemplateStatus,
        authorName: r.authorName,
        approvedByName: r.approvedByName,
        approvedAt: r.approvedAt ? new Date(r.approvedAt) : null,
        updatedAt: new Date(r.updatedAt),
        mayEdit: r.status === 'draft' && can(actor, 'email_template:draft', res),
        maySubmit: r.status === 'draft' && can(actor, 'email_template:draft', res),
        mayApprove: r.status === 'pending_approval' && can(actor, 'email_template:approve', res),
      };
    }),
    mayDraft: can(actor, 'email_template:draft', { type: 'email_template', agencyId: actor.agencyId }),
  };
}

async function loadTemplate(db: Db, actor: Actor, id: string) {
  if (!actor.agencyId || !UUID.test(id)) throw new TemplateEmailError('not_found', 'That template was not found');
  const [t] = await db
    .select()
    .from(emailTemplate)
    .where(and(eq(emailTemplate.id, id), eq(emailTemplate.agencyId, actor.agencyId)))
    .limit(1);
  if (!t) throw new TemplateEmailError('not_found', 'That template was not found');
  return t;
}

function parseInput(input: TemplateInput) {
  const v = templateInputSchema.safeParse(input);
  if (!v.success) throw new TemplateEmailError('invalid', v.error.issues[0]?.message ?? 'Check the template');
  return v.data;
}

export async function createTemplate(db: Db, actor: Actor, input: TemplateInput): Promise<{ id: string }> {
  if (!actor.agencyId || !can(actor, 'email_template:draft', { type: 'email_template', agencyId: actor.agencyId })) {
    throw new TemplateEmailError('forbidden', 'You cannot write templates');
  }
  const v = parseInput(input);
  const [row] = await db
    .insert(emailTemplate)
    .values({ agencyId: actor.agencyId, name: v.name, subject: v.subject, body: v.body, createdBy: actor.userId })
    .returning({ id: emailTemplate.id });
  return { id: row!.id };
}

/** Edit a DRAFT — its author or an admin. An approved template is never edited. */
export async function updateTemplate(db: Db, actor: Actor, id: string, input: TemplateInput): Promise<void> {
  const t = await loadTemplate(db, actor, id);
  if (!can(actor, 'email_template:draft', templateResource(t))) throw new TemplateEmailError('forbidden', 'Only its author or an admin edits this template');
  if (t.status !== 'draft') throw new TemplateEmailError('conflict', 'Only a draft can be edited — retire an approved template and write a new one');
  const v = parseInput(input);
  const done = await db
    .update(emailTemplate)
    .set({ name: v.name, subject: v.subject, body: v.body, updatedAt: sql`now()` })
    .where(and(eq(emailTemplate.id, t.id), eq(emailTemplate.status, 'draft')))
    .returning({ id: emailTemplate.id });
  if (!done.length) throw new TemplateEmailError('conflict', 'This template changed — reload');
}

async function move(db: Db, id: string, from: TemplateStatus[], set: Partial<typeof emailTemplate.$inferInsert>) {
  const done = await db
    .update(emailTemplate)
    .set({ ...set, updatedAt: sql`now()` })
    .where(and(eq(emailTemplate.id, id), inArray(emailTemplate.status, from)))
    .returning({ id: emailTemplate.id });
  if (!done.length) throw new TemplateEmailError('conflict', 'This template changed — reload');
}

/** Ask an admin to approve it. */
export async function submitTemplate(db: Db, actor: Actor, id: string): Promise<void> {
  const t = await loadTemplate(db, actor, id);
  if (!can(actor, 'email_template:draft', templateResource(t))) throw new TemplateEmailError('forbidden', 'Only its author or an admin submits this template');
  await move(db, t.id, ['draft'], { status: 'pending_approval' });
}

export async function approveTemplate(db: Db, actor: Actor, id: string): Promise<void> {
  const t = await loadTemplate(db, actor, id);
  if (!can(actor, 'email_template:approve', templateResource(t))) throw new TemplateEmailError('forbidden', 'Only an owner or admin approves templates');
  await move(db, t.id, ['pending_approval'], { status: 'approved', approvedBy: actor.userId, approvedAt: sql`now()` as unknown as Date });
}

/** Back to its author as a draft. */
export async function sendBackTemplate(db: Db, actor: Actor, id: string): Promise<void> {
  const t = await loadTemplate(db, actor, id);
  if (!can(actor, 'email_template:approve', templateResource(t))) throw new TemplateEmailError('forbidden', 'Only an owner or admin reviews templates');
  await move(db, t.id, ['pending_approval'], { status: 'draft' });
}

/** No longer usable for new batches. Batches already prepared keep their frozen copy. */
export async function retireTemplate(db: Db, actor: Actor, id: string): Promise<void> {
  const t = await loadTemplate(db, actor, id);
  if (!can(actor, 'email_template:approve', templateResource(t))) throw new TemplateEmailError('forbidden', 'Only an owner or admin retires templates');
  await move(db, t.id, ['approved', 'draft', 'pending_approval'], { status: 'retired', retiredAt: sql`now()` as unknown as Date });
}

// ── Saved directory filters ────────────────────────────────────────────────

export type SavedFilter = { id: string; name: string; query: Partial<ContactListQuery> };

export async function saveContactFilter(db: Db, actor: Actor, name: string, query: unknown): Promise<{ id: string }> {
  if (!actor.agencyId || !can(actor, 'contact_filter:manage', { type: 'contact_filter', agencyId: actor.agencyId, ownerId: actor.userId })) {
    throw new TemplateEmailError('forbidden', 'You cannot save filters');
  }
  const label = name.trim().slice(0, 80);
  if (label.length < 2) throw new TemplateEmailError('invalid', 'Give the filter a name');
  const q = contactListQuerySchema.parse(query ?? {});
  const { page: _page, ...stored } = q;
  const [row] = await db
    .insert(contactFilter)
    .values({ agencyId: actor.agencyId, userId: actor.userId, name: label, query: stored })
    .returning({ id: contactFilter.id });
  return { id: row!.id };
}

export async function listMyFilters(db: Db, actor: Actor): Promise<SavedFilter[]> {
  if (!actor.agencyId) return [];
  const rows = await db
    .select({ id: contactFilter.id, name: contactFilter.name, query: contactFilter.query })
    .from(contactFilter)
    .where(and(eq(contactFilter.agencyId, actor.agencyId), eq(contactFilter.userId, actor.userId)))
    .orderBy(desc(contactFilter.createdAt));
  return rows.map((r) => ({ id: r.id, name: r.name, query: contactListQuerySchema.parse(r.query ?? {}) }));
}
