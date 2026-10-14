import { and, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { contactFilter, emailTemplate, user, type Db } from '@repo/db';
import { can, type Actor, type Resource } from '../permissions';
import { contactListQuerySchema, type ContactListQuery } from '../contacts/contact-schema';
import { templateInputSchema, type TemplateInput } from './schema';

/**
 * Email templates and saved filters (docs/adr/0022, amended by ADR 0043). A
 * template is READY when saved — there is no approval step. An owner's or
 * admin's template is for the whole agency (`agency_wide`); an agent's is for
 * that agent alone. Its author or an admin edits or retires it. A prepared
 * batch keeps its own frozen copy, so a sent email always traces to the exact
 * words that went out.
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

export type TemplateStatus = 'draft' | 'pending_approval' | 'approved' | 'retired';

export type TemplateView = {
  id: string;
  name: string;
  subject: string;
  body: string;
  status: TemplateStatus;
  authorName: string | null;
  /** For everyone in the agency (an owner's/admin's), or only its author's. */
  agencyWide: boolean;
  updatedAt: Date;
  /** This person may send it (ADR 0043: its author, or anyone when agency-wide). */
  mayUse: boolean;
  mayEdit: boolean;
  mayRetire: boolean;
};

function templateResource(t: { id: string; agencyId: string; createdBy: string | null }): Resource {
  return { type: 'email_template', id: t.id, agencyId: t.agencyId, ...(t.createdBy ? { ownerId: t.createdBy } : {}) };
}

/**
 * ADR 0043, the ONE rule for sending a template — Bulk email, the assistant, the list send,
 * workflows and the skill all ask it: ready (not retired), in this person's agency, and either
 * for the whole agency or their own. An admin may oversee an agent's own template, not send it.
 */
export function mayUseTemplate(actor: Actor, t: { agencyId: string; createdBy: string | null; status: string; agencyWide: boolean }): boolean {
  if (!actor.agencyId || t.agencyId !== actor.agencyId || t.status !== 'approved') return false;
  if (!can(actor, 'email_batch:create', { type: 'email_batch', agencyId: actor.agencyId })) return false;
  return t.agencyWide || (Boolean(t.createdBy) && t.createdBy === actor.userId);
}

/** In SQL: the templates this person may send (the same rule, for lists). */
export function usableTemplateSql(actor: Actor): SQL {
  return and(
    eq(emailTemplate.agencyId, actor.agencyId ?? '00000000-0000-0000-0000-000000000000'),
    eq(emailTemplate.status, 'approved'),
    or(eq(emailTemplate.agencyWide, true), eq(emailTemplate.createdBy, actor.userId))!,
  )!;
}

/**
 * The templates this actor may see: the agency's and their own; an owner/admin sees every
 * template, to oversee and retire. Retired are hidden. One query.
 */
export async function listTemplates(db: Db, actor: Actor): Promise<{ templates: TemplateView[]; mayDraft: boolean }> {
  if (!actor.agencyId || !can(actor, 'email_template:read', { type: 'email_template', agencyId: actor.agencyId })) {
    throw new TemplateEmailError('forbidden', 'You do not have permission to view templates');
  }
  const admin = can(actor, 'email_template:manage', { type: 'email_template', agencyId: actor.agencyId });
  const rows = await db
    .select({
      id: emailTemplate.id,
      agencyId: emailTemplate.agencyId,
      name: emailTemplate.name,
      subject: emailTemplate.subject,
      body: emailTemplate.body,
      status: emailTemplate.status,
      agencyWide: emailTemplate.agencyWide,
      createdBy: emailTemplate.createdBy,
      authorName: author.name,
      updatedAt: emailTemplate.updatedAt,
    })
    .from(emailTemplate)
    .leftJoin(author, eq(author.id, emailTemplate.createdBy))
    .where(
      and(
        eq(emailTemplate.agencyId, actor.agencyId),
        ne(emailTemplate.status, 'retired'),
        admin ? sql`true` : or(eq(emailTemplate.agencyWide, true), eq(emailTemplate.createdBy, actor.userId))!,
      ),
    )
    .orderBy(desc(emailTemplate.updatedAt));
  return {
    templates: rows.map((r) => {
      const res = templateResource(r);
      const mayChange = r.status !== 'retired' && can(actor, 'email_template:draft', res);
      return {
        id: r.id,
        name: r.name,
        subject: r.subject,
        body: r.body,
        status: r.status as TemplateStatus,
        authorName: r.authorName,
        agencyWide: r.agencyWide,
        updatedAt: new Date(r.updatedAt),
        mayUse: mayUseTemplate(actor, r),
        mayEdit: mayChange,
        mayRetire: mayChange,
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

/** Save a template, ready to use at once (ADR 0043): the agency's if an owner/admin wrote it, its author's own otherwise. */
export async function createTemplate(db: Db, actor: Actor, input: TemplateInput): Promise<{ id: string }> {
  if (!actor.agencyId || !can(actor, 'email_template:draft', { type: 'email_template', agencyId: actor.agencyId })) {
    throw new TemplateEmailError('forbidden', 'You cannot write templates');
  }
  const v = parseInput(input);
  const agencyWide = can(actor, 'email_template:manage', { type: 'email_template', agencyId: actor.agencyId });
  const [row] = await db
    .insert(emailTemplate)
    .values({
      agencyId: actor.agencyId,
      name: v.name,
      subject: v.subject,
      body: v.body,
      createdBy: actor.userId,
      status: 'approved',
      approvedBy: actor.userId,
      approvedAt: sql`now()` as unknown as Date,
      agencyWide,
    })
    .returning({ id: emailTemplate.id });
  return { id: row!.id };
}

/** Change a template — its author or an admin. Batches already prepared keep the words they froze. */
export async function updateTemplate(db: Db, actor: Actor, id: string, input: TemplateInput): Promise<void> {
  const t = await loadTemplate(db, actor, id);
  if (!can(actor, 'email_template:draft', templateResource(t))) throw new TemplateEmailError('forbidden', 'Only its author or an admin edits this template');
  if (t.status === 'retired') throw new TemplateEmailError('conflict', 'A retired template cannot be edited — write a new one');
  const v = parseInput(input);
  const done = await db
    .update(emailTemplate)
    .set({ name: v.name, subject: v.subject, body: v.body, status: 'approved', updatedAt: sql`now()` })
    .where(and(eq(emailTemplate.id, t.id), ne(emailTemplate.status, 'retired')))
    .returning({ id: emailTemplate.id });
  if (!done.length) throw new TemplateEmailError('conflict', 'This template changed — reload');
}

/** No longer usable for new batches — its author or an admin. Batches already prepared keep their frozen copy. */
export async function retireTemplate(db: Db, actor: Actor, id: string): Promise<void> {
  const t = await loadTemplate(db, actor, id);
  if (!can(actor, 'email_template:draft', templateResource(t))) throw new TemplateEmailError('forbidden', 'Only its author or an admin retires this template');
  const done = await db
    .update(emailTemplate)
    .set({ status: 'retired', retiredAt: sql`now()` as unknown as Date, updatedAt: sql`now()` })
    .where(and(eq(emailTemplate.id, t.id), inArray(emailTemplate.status, ['approved', 'draft', 'pending_approval'])))
    .returning({ id: emailTemplate.id });
  if (!done.length) throw new TemplateEmailError('conflict', 'This template changed — reload');
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
