import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { contact, user, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { loadContactHead } from './get-contact';
import { CONTACT_NOT_FOUND, ContactError } from './list-contacts';
import { contactAccessColumns, contactResource, idArray } from './visibility';
import { recordActivity, type ChangeOrigin } from './write-contacts';

/**
 * Deleting a contact (ADR 0025 amendment, 2026-10-09). Never at once: the
 * row is marked `deleted_at`, and from that moment it is gone from every list,
 * profile, search, assistant lookup and email — but Restore brings it back,
 * untouched, for 7 days. After that the cron tick deletes the row for good
 * (`purgeDeletedContacts`), and with it its notes, timeline, appointments,
 * roles and property links; its enquiries (leads) and email conversations
 * stay in the agency's inbox, no longer linked to a contact.
 *
 * Who: the agent it is assigned to, or an owner/admin (`contact:delete`) —
 * never a contact someone reads only through a lead, never read-only, never
 * another agency. Restoring asks the same of the contact as it is now.
 */

export const RESTORE_DAYS = 7;
const DAY_MS = 86_400_000;

/** What deleting this contact takes with it, and what stays — the card's numbers, from SQL. */
export type DeletionImpact = {
  notes: number;
  timeline: number;
  appointments: number;
  upcomingAppointments: number;
  leads: number;
  conversations: number;
};

export async function deletionImpact(db: DbOrTx, contactId: string, now = new Date()): Promise<DeletionImpact> {
  const [r] = await db.execute<Record<keyof DeletionImpact, number>>(sql`
    select
      (select count(*)::int from note n where n.contact_id = ${contactId} and n.deleted_at is null) as notes,
      (select count(*)::int from activity a where a.contact_id = ${contactId}) as timeline,
      (select count(*)::int from appointment p where p.contact_id = ${contactId}) as appointments,
      (select count(*)::int from appointment p where p.contact_id = ${contactId}
         and p.status in ('scheduled', 'rescheduled') and p.ends_at > ${now.toISOString()}::timestamptz) as "upcomingAppointments",
      (select count(*)::int from lead l where l.contact_id = ${contactId}) as leads,
      (select count(*)::int from mail_thread t where t.contact_id = ${contactId}) as conversations`);
  return {
    notes: Number(r?.notes ?? 0),
    timeline: Number(r?.timeline ?? 0),
    appointments: Number(r?.appointments ?? 0),
    upcomingAppointments: Number(r?.upcomingAppointments ?? 0),
    leads: Number(r?.leads ?? 0),
    conversations: Number(r?.conversations ?? 0),
  };
}

/** The contact as it is now, for a delete — refusing anything this person may not delete. */
export async function deletableContact(db: DbOrTx, actor: Actor, contactId: string) {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'contact:delete', resource)) {
    throw new ContactError('forbidden', 'Only the agent this contact is assigned to, or an admin, may delete it');
  }
  return head;
}

/**
 * Delete: hidden everywhere now, restorable for 7 days. Refused while the
 * contact has an upcoming appointment — those live on calendars; cancel them
 * first, so nothing is left on a calendar for a person who is gone.
 */
export async function deleteContact(db: Db, actor: Actor, contactId: string, opts: ChangeOrigin = {}, now = new Date()): Promise<{ restoreUntil: Date }> {
  const head = await deletableContact(db, actor, contactId);
  const impact = await deletionImpact(db, head.row.id, now);
  if (impact.upcomingAppointments) {
    throw new ContactError('conflict', `${head.row.name} has ${impact.upcomingAppointments} upcoming appointment${impact.upcomingAppointments === 1 ? '' : 's'} — cancel ${impact.upcomingAppointments === 1 ? 'it' : 'them'} first. Nothing was deleted.`);
  }
  await db.transaction(async (tx) => {
    const done = await tx
      .update(contact)
      .set({ deletedAt: now, deletedBy: actor.userId, updatedAt: sql`now()` })
      .where(and(eq(contact.id, head.row.id), eq(contact.agencyId, head.row.agencyId), sql`${contact.deletedAt} is null`))
      .returning({ id: contact.id });
    if (!done.length) throw CONTACT_NOT_FOUND();
    await recordActivity(tx, actor, head.row.agencyId, head.row.id, 'contact_deleted', opts.via ? { via: opts.via } : {});
  });
  return { restoreUntil: new Date(now.getTime() + RESTORE_DAYS * DAY_MS) };
}

const deleter = alias(user, 'contact_deleter');
const holder = alias(user, 'contact_holder');

export type DeletedContactView = {
  id: string;
  name: string;
  email: string | null;
  assigneeName: string | null;
  deletedAt: Date;
  deletedByName: string | null;
  /** When the cron tick deletes it for good (it may run up to a tick later). */
  goneAt: Date;
};

const deletedColumns = {
  id: contact.id,
  agencyId: contact.agencyId,
  name: contact.name,
  email: contact.email,
  assignedTo: contact.assignedTo,
  assigneeName: holder.name,
  deletedAt: contact.deletedAt,
  deletedByName: deleter.name,
  ...contactAccessColumns(contact.id, contact.agencyId),
};

/**
 * "Recently deleted": the contacts deleted in the last 7 days that THIS person
 * may bring back — an owner/admin: the agency's; anyone else: those assigned
 * to them. One statement.
 */
export async function listDeletedContacts(db: DbOrTx, actor: Actor, now = new Date()): Promise<DeletedContactView[]> {
  if (!actor.agencyId) return [];
  const directory = { type: 'contact', agencyId: actor.agencyId };
  if (!can(actor, 'contact:read', directory)) return [];
  const seesAll = can(actor, 'contact:read_all', directory);
  const rows = await db
    .select(deletedColumns)
    .from(contact)
    .leftJoin(holder, eq(holder.id, contact.assignedTo))
    .leftJoin(deleter, eq(deleter.id, contact.deletedBy))
    .where(
      and(
        eq(contact.agencyId, actor.agencyId),
        isNotNull(contact.deletedAt),
        gt(contact.deletedAt, new Date(now.getTime() - RESTORE_DAYS * DAY_MS)),
        sql`${contact.mergedIntoId} is null`,
        ...(seesAll ? [] : [eq(contact.assignedTo, actor.userId)]),
      ),
    )
    .orderBy(desc(contact.deletedAt))
    .limit(100);
  return rows
    .filter((r) => can(actor, 'contact:delete', contactResource({ id: r.id, agencyId: r.agencyId, assignedTo: r.assignedTo, leadAssigneeIds: idArray(r.leadAssigneeIds) })))
    .map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      assigneeName: r.assigneeName,
      deletedAt: new Date(r.deletedAt!),
      deletedByName: r.deletedByName,
      goneAt: new Date(new Date(r.deletedAt!).getTime() + RESTORE_DAYS * DAY_MS),
    }));
}

/** One deleted contact this person may restore now — or a refusal that says why. */
export async function restorableContact(db: DbOrTx, actor: Actor, contactId: string, now = new Date()): Promise<DeletedContactView & { agencyId: string }> {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(contactId)) throw CONTACT_NOT_FOUND();
  const [r] = await db
    .select(deletedColumns)
    .from(contact)
    .leftJoin(holder, eq(holder.id, contact.assignedTo))
    .leftJoin(deleter, eq(deleter.id, contact.deletedBy))
    .where(and(eq(contact.id, contactId), eq(contact.agencyId, actor.agencyId), sql`${contact.mergedIntoId} is null`))
    .limit(1);
  if (!r) throw CONTACT_NOT_FOUND();
  const resource = contactResource({ id: r.id, agencyId: r.agencyId, assignedTo: r.assignedTo, leadAssigneeIds: idArray(r.leadAssigneeIds) });
  if (!can(actor, 'contact:delete', resource)) {
    // Never say more about a contact this person could not see anyway.
    if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
    throw new ContactError('forbidden', 'Only the agent this contact is assigned to, or an admin, may restore it');
  }
  if (!r.deletedAt) throw new ContactError('conflict', `${r.name} is not deleted.`);
  const goneAt = new Date(new Date(r.deletedAt).getTime() + RESTORE_DAYS * DAY_MS);
  if (goneAt.getTime() <= now.getTime()) {
    throw new ContactError('conflict', `${r.name} was deleted more than ${RESTORE_DAYS} days ago and can no longer be restored.`);
  }
  return {
    id: r.id,
    agencyId: r.agencyId,
    name: r.name,
    email: r.email,
    assigneeName: r.assigneeName,
    deletedAt: new Date(r.deletedAt),
    deletedByName: r.deletedByName,
    goneAt,
  };
}

/** Bring a deleted contact back, as it was, within its 7 days. */
export async function restoreDeletedContact(db: Db, actor: Actor, contactId: string, opts: ChangeOrigin = {}, now = new Date()): Promise<void> {
  const c = await restorableContact(db, actor, contactId, now);
  await db.transaction(async (tx) => {
    const done = await tx
      .update(contact)
      .set({ deletedAt: null, deletedBy: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(contact.id, c.id),
          eq(contact.agencyId, c.agencyId),
          gt(contact.deletedAt, new Date(now.getTime() - RESTORE_DAYS * DAY_MS)),
        ),
      )
      .returning({ id: contact.id });
    if (!done.length) throw new ContactError('conflict', `${c.name} can no longer be restored.`);
    await recordActivity(tx, actor, c.agencyId, c.id, 'contact_undeleted', opts.via ? { via: opts.via } : {});
  });
}

/**
 * The cron tick: contacts deleted more than 7 days ago are deleted for good.
 * Their notes, timeline, appointments, roles and property links go with them
 * (foreign keys); leads and conversations stay, unlinked. Batched.
 */
export async function purgeDeletedContacts(db: Db, now = new Date(), limit = 500): Promise<number> {
  const due = await db
    .select({ id: contact.id })
    .from(contact)
    .where(and(isNotNull(contact.deletedAt), lt(contact.deletedAt, new Date(now.getTime() - RESTORE_DAYS * DAY_MS))))
    .limit(limit);
  if (!due.length) return 0;
  const gone = await db
    .delete(contact)
    .where(
      and(
        inArray(
          contact.id,
          due.map((d) => d.id),
        ),
        lt(contact.deletedAt, new Date(now.getTime() - RESTORE_DAYS * DAY_MS)),
      ),
    )
    .returning({ id: contact.id });
  return gone.length;
}
