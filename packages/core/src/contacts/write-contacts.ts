import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { emitWorkflowEvent } from '../workflows/events';
import { z } from 'zod';
import {
  activity,
  agentProfile,
  contact,
  contactRole,
  membership,
  user,
  type Db,
  type DbOrTx,
} from '@repo/db';
import { can, type Actor, type MembershipRole } from '../permissions';
import {
  CONTACT_ROLES,
  contactFieldsSchema,
  createContactSchema,
  nextActionSchema,
  updateContactSchema,
  type NextActionInput,
  type ActivityKind,
  type CreateContactInput,
  type UpdateContactInput,
  type ContactRoleKind,
} from './contact-schema';
import { loadContactHead } from './get-contact';
import { CONTACT_NOT_FOUND, ContactError, roleArray } from './list-contacts';
import { contactResource } from './visibility';

/**
 * Writing contacts by hand (ADR 0018). Every change is in one transaction with
 * the timeline entry that records it, and nothing here runs a network call.
 * Automatic capture (enquiries, offers, email) is NOT here — it is the
 * database's `contact_upsert`, which only ever fills blanks.
 */

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function firstIssue(err: { issues: { message: string }[] }): string {
  return err.issues[0]?.message ?? 'Check the highlighted fields';
}

/** One timeline entry, inside the caller's transaction. */
export async function recordActivity(
  tx: DbOrTx,
  actor: Actor,
  agencyId: string,
  contactId: string,
  kind: ActivityKind,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(activity).values({
    agencyId,
    contactId,
    kind,
    actorType: 'user',
    actorId: actor.userId,
    payload,
  });
}

/** The contact that already holds this email in this agency, if one does. */
async function holderOf(db: DbOrTx, agencyId: string, email: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: contact.id })
    .from(contact)
    .where(
      and(eq(contact.agencyId, agencyId), eq(contact.email, email), sql`${contact.mergedIntoId} is null`),
    )
    .limit(1);
  return row?.id;
}

const duplicate = (id?: string) =>
  new ContactError('duplicate', 'A contact with that email already exists', id);

/** Somebody a contact can be given to: an active member who could then work it. */
export type ContactAssignee = { userId: string; name: string };

export async function listContactAssignees(db: Db, actor: Actor): Promise<ContactAssignee[]> {
  if (!actor.agencyId) return [];
  if (!can(actor, 'contact:assign', { type: 'contact', agencyId: actor.agencyId })) return [];
  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      displayName: agentProfile.displayName,
      role: membership.role,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .leftJoin(agentProfile, eq(agentProfile.userId, membership.userId))
    .where(and(eq(membership.agencyId, actor.agencyId), eq(membership.status, 'active')))
    .orderBy(asc(user.name), asc(user.id));
  // Only somebody who could edit a contact of their own: a read-only member
  // given a contact would own a thing they may not touch.
  return rows
    .filter((r) =>
      can(
        { userId: r.userId, agencyId: actor.agencyId, membershipRole: r.role as MembershipRole },
        'contact:update',
        { type: 'contact', id: 'probe', agencyId: actor.agencyId, ownerId: r.userId },
      ),
    )
    .map((r) => ({ userId: r.userId, name: r.displayName || r.name || r.email }));
}

/** Throws unless `userId` is in the assignee list `listContactAssignees` would draw. */
async function assertAssignable(db: DbOrTx, actor: Actor, userId: string): Promise<void> {
  if (!(await assignableMember(db, actor, userId))) throw new ContactError('invalid', 'That person cannot be given contacts');
}

/**
 * The member `userId`, named as the assignee list names them, if they may be
 * given contacts in the actor's agency now: active, and allowed to edit a
 * contact of their own (so never read-only). Null otherwise — including
 * anybody from another agency.
 */
export async function assignableMember(db: DbOrTx, actor: Actor, userId: string): Promise<ContactAssignee | null> {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const [row] = await db
    .select({ role: membership.role, name: user.name, email: user.email, displayName: agentProfile.displayName })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .leftJoin(agentProfile, eq(agentProfile.userId, membership.userId))
    .where(
      and(
        eq(membership.agencyId, actor.agencyId as string),
        eq(membership.userId, userId),
        eq(membership.status, 'active'),
      ),
    )
    .limit(1);
  if (!row) return null;
  const them: Actor = { userId, agencyId: actor.agencyId, membershipRole: row.role as MembershipRole };
  if (!can(them, 'contact:update', { type: 'contact', id: 'probe', agencyId: actor.agencyId, ownerId: userId })) return null;
  return { userId, name: row.displayName || row.name || row.email };
}

/**
 * Add a contact by hand. An agent's new contact is theirs; an admin may give
 * it to somebody (or nobody). An email already on a contact is refused with
 * that contact's id — never silently merged.
 */
export async function createContact(
  db: Db,
  actor: Actor,
  input: CreateContactInput,
  /** `import`: a row of a contacts import (ADR 0029 amendment); the timeline says so. */
  opts: { source?: 'manual' | 'import' } = {},
): Promise<{ id: string }> {
  if (!actor.agencyId) throw new ContactError('forbidden', 'You cannot add contacts');
  const agencyId = actor.agencyId;
  const directory = { type: 'contact', agencyId };
  if (!can(actor, 'contact:create', directory)) {
    throw new ContactError('forbidden', 'You cannot add contacts');
  }
  const parsed = createContactSchema.safeParse(input);
  if (!parsed.success) throw new ContactError('invalid', firstIssue(parsed.error));
  const v = parsed.data;

  const mayAssign = can(actor, 'contact:assign', directory);
  const assignedTo = mayAssign ? (v.assignedTo ?? null) : actor.userId;
  if (assignedTo && assignedTo !== actor.userId) await assertAssignable(db, actor, assignedTo);

  if (v.email) {
    const existing = await holderOf(db, agencyId, v.email);
    if (existing) throw duplicate(existing);
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(contact)
        .values({
          agencyId,
          name: v.name,
          email: v.email ?? null,
          phone: v.phone ?? null,
          source: opts.source ?? 'manual',
          assignedTo,
          nextAction: v.nextAction ?? null,
          nextActionAt: v.nextActionAt ?? null,
          ...(v.marketingConsent
            ? {
                marketingConsentAt: sql`now()`,
                marketingConsentBy: actor.userId,
                marketingConsentNote: v.marketingConsentNote ?? null,
              }
            : {}),
          createdBy: actor.userId,
        })
        .returning({ id: contact.id });
      const id = row!.id;
      if (v.roles.length) {
        await tx
          .insert(contactRole)
          .values(v.roles.map((role) => ({ contactId: id, role, source: 'manual' as const, createdBy: actor.userId })))
          .onConflictDoNothing();
      }
      await recordActivity(tx, actor, agencyId, id, 'contact_created', { roles: v.roles, ...(opts.source === 'import' ? { via: 'import' } : {}) });
      // ADR 0041: a new contact may trigger a workflow — in the same transaction.
      await emitWorkflowEvent(tx, { agencyId, kind: 'contact.created', contactId: id, actor, data: { source: opts.source ?? 'manual' } });
      if (v.marketingConsent) {
        await recordActivity(tx, actor, agencyId, id, 'consent_recorded', {
          note: v.marketingConsentNote ?? null,
        });
      }
      return { id };
    });
  } catch (err) {
    // Two people adding the same email at once: the unique index decides.
    if (isUniqueViolation(err)) throw duplicate(v.email ? await holderOf(db, agencyId, v.email) : undefined);
    throw err;
  }
}

/**
 * Change a contact's details, roles, next action and consent: an admin, or the
 * member it is assigned to. The roles sent are the whole set — a tag left out
 * is removed, inferred ones included (an agent may correct what was guessed).
 */
export async function updateContact(
  db: Db,
  actor: Actor,
  contactId: string,
  input: UpdateContactInput,
): Promise<void> {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'contact:update', resource)) {
    throw new ContactError('forbidden', 'Only the agent this contact is assigned to, or an admin, may edit it');
  }
  const parsed = updateContactSchema.safeParse(input);
  if (!parsed.success) throw new ContactError('invalid', firstIssue(parsed.error));
  const v = parsed.data;
  const { row } = head;
  const agencyId = row.agencyId;

  const email = v.email ?? null;
  if (email && email !== row.email) {
    const existing = await holderOf(db, agencyId, email);
    if (existing && existing !== row.id) throw duplicate(existing);
  }

  const before = {
    name: row.name,
    email: row.email,
    phone: row.phone,
    nextAction: row.nextAction,
    nextActionAt: row.nextActionAt ? new Date(row.nextActionAt).toISOString() : null,
  };
  const after = {
    name: v.name,
    email,
    phone: v.phone ?? null,
    nextAction: v.nextAction ?? null,
    nextActionAt: v.nextActionAt ? v.nextActionAt.toISOString() : null,
  };
  const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => before[k] !== after[k]);

  const hadRoles = roleArray(row.roles);
  const added = v.roles.filter((r) => !hadRoles.includes(r));
  const removed = hadRoles.filter((r) => !v.roles.includes(r));

  const hadConsent = Boolean(row.marketingConsentAt);
  const consentChange = v.marketingConsent === hadConsent ? null : v.marketingConsent ? 'recorded' : 'withdrawn';

  if (!changed.length && !added.length && !removed.length && !consentChange &&
      (v.marketingConsentNote ?? null) === (row.marketingConsentNote ?? null)) {
    return;
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(contact)
        .set({
          name: after.name,
          email: after.email,
          phone: after.phone,
          nextAction: after.nextAction,
          nextActionAt: v.nextActionAt ?? null,
          ...(consentChange === 'recorded'
            ? {
                marketingConsentAt: sql`now()`,
                marketingConsentBy: actor.userId,
                marketingConsentNote: v.marketingConsentNote ?? null,
              }
            : consentChange === 'withdrawn'
              ? { marketingConsentAt: null, marketingConsentBy: null, marketingConsentNote: null }
              : hadConsent
                ? { marketingConsentNote: v.marketingConsentNote ?? null }
                : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(contact.id, row.id), eq(contact.agencyId, agencyId)));

      if (removed.length) {
        await tx
          .delete(contactRole)
          .where(and(eq(contactRole.contactId, row.id), inArray(contactRole.role, removed)));
      }
      if (added.length) {
        await tx
          .insert(contactRole)
          .values(added.map((role) => ({ contactId: row.id, role, source: 'manual' as const, createdBy: actor.userId })))
          .onConflictDoNothing();
      }

      if (changed.length) await recordActivity(tx, actor, agencyId, row.id, 'contact_updated', { fields: changed });
      for (const role of added) await recordActivity(tx, actor, agencyId, row.id, 'role_added', { role });
      for (const role of removed) await recordActivity(tx, actor, agencyId, row.id, 'role_removed', { role });
      if (consentChange) {
        await recordActivity(tx, actor, agencyId, row.id, `consent_${consentChange}` as ActivityKind, {
          note: v.marketingConsentNote ?? null,
        });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate(email ? await holderOf(db, agencyId, email) : undefined);
    throw err;
  }
}

/**
 * How a change was made, on its timeline entry: by hand (absent), or by an
 * assistant card the person approved (ADR 0025).
 */
export type ChangeOrigin = { via?: 'assistant' };

/** Give a contact to a member, or to nobody. Admins only. */
export async function assignContact(
  db: Db,
  actor: Actor,
  contactId: string,
  assignTo: string | null,
  opts: ChangeOrigin & {
    /** Refuse if the contact is no longer held by this person (a card shows who had it). */
    expectedFrom?: string | null;
  } = {},
): Promise<void> {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'contact:assign', resource)) {
    throw new ContactError('forbidden', 'Only an admin may assign contacts');
  }
  if (opts.expectedFrom !== undefined && opts.expectedFrom !== head.row.assignedTo) {
    throw new ContactError('conflict', `${head.row.name} was given to someone else after this was proposed`);
  }
  if (assignTo) await assertAssignable(db, actor, assignTo);
  if (assignTo === head.row.assignedTo) return;

  await db.transaction(async (tx) => {
    await tx
      .update(contact)
      .set({ assignedTo: assignTo, updatedAt: sql`now()` })
      .where(and(eq(contact.id, head.row.id), eq(contact.agencyId, head.row.agencyId)));
    await recordActivity(tx, actor, head.row.agencyId, head.row.id, 'contact_assigned', {
      from: head.row.assignedTo,
      to: assignTo,
      ...(opts.via ? { via: opts.via } : {}),
    });
  });
}

/** Why consent is never recorded for someone who unsubscribed (ADR 0022): it is theirs to give back. */
export const UNSUBSCRIBED_REASON = 'unsubscribed — only they can give permission again';

/** The contact, if this person may edit it — the edit form's rule (`contact:update`). */
async function editableHead(db: DbOrTx, actor: Actor, contactId: string, what: string) {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'contact:update', resource)) {
    throw new ContactError('forbidden', `Only the agent ${head.row.name} is assigned to, or an admin, may ${what}`);
  }
  return head;
}

/**
 * Record that this person agreed to marketing email, and how — dated and
 * attributed on the record and the timeline (the Spam Act asks who, when and
 * how). Whoever may edit the contact may. Refused for someone who
 * unsubscribed: only they can opt back in. Someone who already agreed keeps
 * the consent they gave (nothing is overwritten).
 */
export async function recordMarketingConsent(
  db: Db,
  actor: Actor,
  contactId: string,
  how: string,
  opts: ChangeOrigin = {},
): Promise<'recorded' | 'already'> {
  const head = await editableHead(db, actor, contactId, 'record their consent');
  const note = how.trim();
  if (!note) throw new ContactError('invalid', 'Say how they gave consent');
  if (note.length > 300) throw new ContactError('invalid', 'Keep how they gave consent under 300 characters');
  if (head.row.emailOptOutAt) throw new ContactError('conflict', `${head.row.name} ${UNSUBSCRIBED_REASON}`);
  if (head.row.marketingConsentAt) return 'already';
  await db.transaction(async (tx) => {
    await tx
      .update(contact)
      .set({ marketingConsentAt: sql`now()`, marketingConsentBy: actor.userId, marketingConsentNote: note, updatedAt: sql`now()` })
      .where(and(eq(contact.id, head.row.id), eq(contact.agencyId, head.row.agencyId)));
    await recordActivity(tx, actor, head.row.agencyId, head.row.id, 'consent_recorded', { note, ...(opts.via ? { via: opts.via } : {}) });
  });
  return 'recorded';
}

/** Withdraw a recorded consent, with the reason on the timeline. Same permission as recording it. */
export async function withdrawMarketingConsent(
  db: Db,
  actor: Actor,
  contactId: string,
  reason: string,
  opts: ChangeOrigin = {},
): Promise<'withdrawn' | 'none'> {
  const head = await editableHead(db, actor, contactId, 'withdraw their consent');
  const note = reason.trim();
  if (!note) throw new ContactError('invalid', 'Say why consent is withdrawn');
  if (note.length > 300) throw new ContactError('invalid', 'Keep the reason under 300 characters');
  if (!head.row.marketingConsentAt) return 'none';
  await db.transaction(async (tx) => {
    await tx
      .update(contact)
      .set({ marketingConsentAt: null, marketingConsentBy: null, marketingConsentNote: null, updatedAt: sql`now()` })
      .where(and(eq(contact.id, head.row.id), eq(contact.agencyId, head.row.agencyId)));
    await recordActivity(tx, actor, head.row.agencyId, head.row.id, 'consent_withdrawn', { note, ...(opts.via ? { via: opts.via } : {}) });
  });
  return 'withdrawn';
}

/** The edit form's own details — the only things `editContactDetails` can change. */
export type ContactDetailsPatch = { name?: string; email?: string | null; phone?: string | null; roles?: ContactRoleKind[] };
export type ContactDetails = { name: string; email: string | null; phone: string | null; roles: ContactRoleKind[] };

const detailsPatchSchema = z
  .object({
    name: contactFieldsSchema.shape.name.optional(),
    email: z.union([z.literal(null), z.string().trim().max(200).toLowerCase().pipe(z.string().email('That does not look like an email address'))]).optional(),
    phone: z.union([z.literal(null), z.string().trim().min(1).max(40)]).optional(),
    roles: z.array(z.enum(CONTACT_ROLES)).max(CONTACT_ROLES.length).optional(),
  })
  .strict();

/** A contact's details as the edit form shows them — for a card's "before". */
export function contactDetailsOf(row: { name: string; email: string | null; phone: string | null; roles: unknown }): ContactDetails {
  return { name: row.name, email: row.email, phone: row.phone, roles: roleArray(row.roles) as ContactRoleKind[] };
}

const sameRoles = (a: readonly string[], b: readonly string[]) => [...a].sort().join(',') === [...b].sort().join(',');

/**
 * Change some of a contact's details — name, email, phone, roles (the whole
 * set) — and nothing else: never who it is assigned to, consent, the next
 * action or the archive. Whoever may edit the contact may. With `expected`
 * (an assistant card's "before"), refused if any of those fields changed
 * since — the person approved what they saw. An email another contact has is
 * refused, never merged. Email or phone must remain.
 */
export async function editContactDetails(
  db: Db,
  actor: Actor,
  contactId: string,
  patch: ContactDetailsPatch,
  opts: ChangeOrigin & { expected?: Partial<ContactDetails> } = {},
): Promise<{ changed: (keyof ContactDetails)[] }> {
  const head = await editableHead(db, actor, contactId, 'edit it');
  const parsed = detailsPatchSchema.safeParse(patch);
  if (!parsed.success) throw new ContactError('invalid', firstIssue(parsed.error));
  const p = parsed.data;
  const { row } = head;
  const now = contactDetailsOf(row);

  if (opts.expected) {
    for (const [k, v] of Object.entries(opts.expected) as [keyof ContactDetails, ContactDetails[keyof ContactDetails]][]) {
      const same = k === 'roles' ? sameRoles(now.roles, v as string[]) : now[k] === v;
      if (!same) throw new ContactError('conflict', `${row.name}’s ${k} changed after this was proposed`);
    }
  }

  const next: ContactDetails = {
    name: p.name ?? now.name,
    email: p.email === undefined ? now.email : p.email,
    phone: p.phone === undefined ? now.phone : p.phone,
    roles: p.roles ?? now.roles,
  };
  if (!next.email && !next.phone) throw new ContactError('invalid', 'Keep an email or a phone number, so they can be reached');
  if (next.email && next.email !== now.email) {
    const existing = await holderOf(db, row.agencyId, next.email);
    if (existing && existing !== row.id) throw duplicate(existing);
  }
  const changed = (['name', 'email', 'phone'] as const).filter((k) => next[k] !== now[k]);
  const added = next.roles.filter((r) => !now.roles.includes(r));
  const removed = now.roles.filter((r) => !next.roles.includes(r));
  if (!changed.length && !added.length && !removed.length) return { changed: [] };
  const via = opts.via ? { via: opts.via } : {};

  try {
    await db.transaction(async (tx) => {
      if (changed.length) {
        await tx
          .update(contact)
          .set({ name: next.name, email: next.email, phone: next.phone, updatedAt: sql`now()` })
          .where(and(eq(contact.id, row.id), eq(contact.agencyId, row.agencyId)));
      }
      if (removed.length) {
        await tx.delete(contactRole).where(and(eq(contactRole.contactId, row.id), inArray(contactRole.role, removed)));
      }
      if (added.length) {
        await tx
          .insert(contactRole)
          .values(added.map((role) => ({ contactId: row.id, role, source: 'manual' as const, createdBy: actor.userId })))
          .onConflictDoNothing();
      }
      if (changed.length) await recordActivity(tx, actor, row.agencyId, row.id, 'contact_updated', { fields: changed, ...via });
      for (const role of added) await recordActivity(tx, actor, row.agencyId, row.id, 'role_added', { role, ...via });
      for (const role of removed) await recordActivity(tx, actor, row.agencyId, row.id, 'role_removed', { role, ...via });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate(next.email ? await holderOf(db, row.agencyId, next.email) : undefined);
    throw err;
  }
  return { changed: [...changed, ...(added.length || removed.length ? (['roles'] as const) : [])] };
}

/**
 * Archive a contact, or bring it back. Hides it from the directory's default
 * view; deletes nothing, changes nothing else. A new enquiry from them still
 * lands on the same row. Whoever may edit the contact may do this.
 */
export async function setContactArchived(
  db: Db,
  actor: Actor,
  contactId: string,
  archived: boolean,
  opts: ChangeOrigin = {},
): Promise<void> {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'contact:archive', resource)) {
    throw new ContactError('forbidden', 'Only the agent this contact is assigned to, or an admin, may archive it');
  }
  if (Boolean(head.row.archivedAt) === archived) return;
  await db.transaction(async (tx) => {
    await tx
      .update(contact)
      .set(
        archived
          ? { archivedAt: sql`now()`, archivedBy: actor.userId, updatedAt: sql`now()` }
          : { archivedAt: null, archivedBy: null, updatedAt: sql`now()` },
      )
      .where(and(eq(contact.id, head.row.id), eq(contact.agencyId, head.row.agencyId)));
    await recordActivity(tx, actor, head.row.agencyId, head.row.id, archived ? 'contact_archived' : 'contact_restored', opts.via ? { via: opts.via } : {});
  });
}

/**
 * The next action alone — the overview's quick edit. Same permission as any
 * other edit (`contact:update`): the assignee or an admin.
 */
export async function setNextAction(
  db: Db,
  actor: Actor,
  contactId: string,
  input: NextActionInput,
): Promise<void> {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'contact:update', resource)) {
    throw new ContactError('forbidden', 'Only the agent this contact is assigned to, or an admin, may change it');
  }
  const parsed = nextActionSchema.safeParse(input);
  if (!parsed.success) throw new ContactError('invalid', firstIssue(parsed.error));
  const v = parsed.data;
  await db.transaction(async (tx) => {
    await tx
      .update(contact)
      .set({ nextAction: v.nextAction ?? null, nextActionAt: v.nextActionAt ?? null, updatedAt: sql`now()` })
      .where(and(eq(contact.id, head.row.id), eq(contact.agencyId, head.row.agencyId)));
    await recordActivity(tx, actor, head.row.agencyId, head.row.id, 'contact_updated', { fields: ['nextAction'] });
  });
}
