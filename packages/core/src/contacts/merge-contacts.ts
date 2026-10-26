import { and, eq, sql } from 'drizzle-orm';
import { activity, appointment, contact, document, lead, mailThread, note, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { loadContactHead } from './get-contact';
import { CONTACT_NOT_FOUND, ContactError } from './list-contacts';
import { contactResource } from './visibility';
import { recordActivity } from './write-contacts';

/**
 * Fold `loserId` into `survivorId` (ADR 0018). Admins only: who a lead belongs
 * to decides who may see the person, so a merge changes visibility.
 *
 * Nothing is deleted. The loser's leads, conversations, notes, appointments and timeline move
 * to the survivor; its roles and property ties are COPIED (the loser keeps its
 * own, harmlessly, since a merged contact is never listed); the survivor fills
 * any blank email, phone or assignee from the loser and keeps everything it
 * had. The loser keeps its row with `merged_into_id` set, so an old link to it
 * lands on the survivor.
 *
 * Both rows are locked first, so two merges of the same pair cannot cross.
 */
export async function mergeContacts(
  db: Db,
  actor: Actor,
  survivorId: string,
  loserId: string,
): Promise<void> {
  if (survivorId === loserId) throw new ContactError('invalid', 'Pick two different contacts');
  const [survivor, loser] = await Promise.all([
    loadContactHead(db, actor, survivorId),
    loadContactHead(db, actor, loserId),
  ]);
  if (!survivor || !loser) throw CONTACT_NOT_FOUND();
  for (const h of [survivor, loser]) {
    const r = contactResource(h.facts);
    if (!can(actor, 'contact:read', r)) throw CONTACT_NOT_FOUND();
    if (!can(actor, 'contact:merge', r)) throw new ContactError('forbidden', 'Only an admin may merge contacts');
  }
  const agencyId = survivor.row.agencyId;

  await db.transaction(async (tx) => {
    const locked = await tx.execute<{ id: string; merged_into_id: string | null }>(sql`
      select id, merged_into_id from contact
      where id in (${survivorId}, ${loserId}) and agency_id = ${agencyId}
      order by id for update
    `);
    if (locked.length !== 2 || locked.some((r) => r.merged_into_id)) {
      throw new ContactError('invalid', 'One of those contacts has already been merged');
    }

    // The loser stops being "live" first, so its email no longer holds the
    // unique index the survivor may now take it into.
    await tx
      .update(contact)
      .set({ mergedIntoId: survivorId, updatedAt: sql`now()` })
      .where(eq(contact.id, loserId));
    await tx.execute(sql`
      update contact s set
        email = coalesce(s.email, l.email),
        phone = coalesce(s.phone, l.phone),
        assigned_to = coalesce(s.assigned_to, l.assigned_to),
        updated_at = now()
      from contact l
      where s.id = ${survivorId} and l.id = ${loserId}
    `);

    await tx.update(lead).set({ contactId: survivorId }).where(and(eq(lead.contactId, loserId), eq(lead.agencyId, agencyId)));
    await tx.update(mailThread).set({ contactId: survivorId }).where(and(eq(mailThread.contactId, loserId), eq(mailThread.agencyId, agencyId)));
    await tx.update(note).set({ contactId: survivorId }).where(eq(note.contactId, loserId));
    await tx.update(appointment).set({ contactId: survivorId }).where(and(eq(appointment.contactId, loserId), eq(appointment.agencyId, agencyId)));
    await tx.update(activity).set({ contactId: survivorId }).where(eq(activity.contactId, loserId));
    // ADR 0053: their documents move with them, like their notes.
    await tx.update(document).set({ contactId: survivorId, updatedAt: sql`now()` }).where(and(eq(document.contactId, loserId), eq(document.agencyId, agencyId)));
    await tx.execute(sql`
      insert into contact_role (contact_id, role, source, created_by)
      select ${survivorId}, role, source, created_by from contact_role where contact_id = ${loserId}
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into contact_property (contact_id, property_id, relation, note, created_by)
      select ${survivorId}, property_id, relation, note, created_by from contact_property where contact_id = ${loserId}
      on conflict do nothing
    `);

    await recordActivity(tx, actor, agencyId, survivorId, 'contact_merged', {
      mergedId: loserId,
      name: loser.row.name,
      email: loser.row.email,
      phone: loser.row.phone,
    });
  });
}
