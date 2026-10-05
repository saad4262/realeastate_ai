import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
  createContactSchema,
  updateContactSchema,
  type ActivityKind,
  type CreateContactInput,
  type UpdateContactInput,
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
  const [row] = await db
    .select({ role: membership.role })
    .from(membership)
    .where(
      and(
        eq(membership.agencyId, actor.agencyId as string),
        eq(membership.userId, userId),
        eq(membership.status, 'active'),
      ),
    )
    .limit(1);
  const them: Actor = { userId, agencyId: actor.agencyId, membershipRole: row?.role as MembershipRole };
  const ok =
    row &&
    can(them, 'contact:update', { type: 'contact', id: 'probe', agencyId: actor.agencyId, ownerId: userId });
  if (!ok) throw new ContactError('invalid', 'That person cannot be given contacts');
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
          source: 'manual',
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
      await recordActivity(tx, actor, agencyId, id, 'contact_created', { roles: v.roles });
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

/** Give a contact to a member, or to nobody. Admins only. */
export async function assignContact(
  db: Db,
  actor: Actor,
  contactId: string,
  assignTo: string | null,
): Promise<void> {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'contact:assign', resource)) {
    throw new ContactError('forbidden', 'Only an admin may assign contacts');
  }
  if (assignTo === head.row.assignedTo) return;
  if (assignTo) await assertAssignable(db, actor, assignTo);

  await db.transaction(async (tx) => {
    await tx
      .update(contact)
      .set({ assignedTo: assignTo, updatedAt: sql`now()` })
      .where(and(eq(contact.id, head.row.id), eq(contact.agencyId, head.row.agencyId)));
    await recordActivity(tx, actor, head.row.agencyId, head.row.id, 'contact_assigned', {
      from: head.row.assignedTo,
      to: assignTo,
    });
  });
}
