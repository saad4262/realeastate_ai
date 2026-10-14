import { and, eq, isNull } from 'drizzle-orm';
import { contact, lead, listing, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { listingScopeFilters } from '../listings/scope';
import { LeadTriageError } from './triage-lead';
import { atomically, emitWorkflowEvent } from '../workflows/events';

/**
 * A lead a member records by hand (ADR 0040): a contact's interest in one of
 * the listings their figures cover — an agent's own, any of the agency's for
 * an owner/admin (`listingScopeFilters`). It is assigned to the person who
 * records it (decided Q4), marked `source = 'manual'`, and never an offer.
 * The lead insert trigger links it to the contact by email (ADR 0018), and
 * the conversation trigger opens its thread, as for a website enquiry.
 */
export const MANUAL_LEAD_KINDS = ['enquiry', 'inspection', 'appraisal'] as const;
export type ManualLeadKind = (typeof MANUAL_LEAD_KINDS)[number];

export async function createManualLead(
  db: DbOrTx,
  actor: Actor,
  input: { contactId: string; listingId: string; kind: ManualLeadKind; message: string | null },
): Promise<{ leadId: string }> {
  if (!actor.agencyId || !can(actor, 'lead:create', { type: 'lead', agencyId: actor.agencyId })) {
    throw new LeadTriageError('forbidden', 'You may not record leads');
  }
  if (!MANUAL_LEAD_KINDS.includes(input.kind)) throw new LeadTriageError('invalid', 'Choose enquiry, inspection or appraisal');
  const [l] = await db
    .select({ id: listing.id, propertyId: listing.propertyId })
    .from(listing)
    .where(and(eq(listing.id, input.listingId), ...listingScopeFilters(actor)))
    .limit(1);
  if (!l) throw new LeadTriageError('not_found', 'That listing is not one you can record leads on');
  const [c] = await db
    .select({ name: contact.name, email: contact.email, phone: contact.phone })
    .from(contact)
    .where(and(eq(contact.id, input.contactId), eq(contact.agencyId, actor.agencyId), isNull(contact.mergedIntoId), isNull(contact.archivedAt)))
    .limit(1);
  if (!c) throw new LeadTriageError('not_found', 'That contact was not found');
  if (!c.email) throw new LeadTriageError('invalid', `${c.name} has no email address — add one to the contact first`);
  const agencyId = actor.agencyId;
  const email = c.email;
  // The lead and its workflow event (ADR 0041), together or not at all.
  const row = await atomically(db, async (tx) => {
  const [made] = await tx
    .insert(lead)
    .values({
      propertyId: l.propertyId,
      listingId: l.id,
      agencyId,
      name: c.name,
      email,
      phone: c.phone,
      message: input.message?.trim() || null,
      kind: input.kind,
      status: 'new',
      source: 'manual',
      assignedTo: actor.userId,
    })
    .returning({ id: lead.id, contactId: lead.contactId });
  await emitWorkflowEvent(tx, { agencyId, kind: 'lead.created', leadId: made!.id, contactId: made!.contactId, listingId: l.id, actor, data: { source: 'manual' } });
  return made!;
  });
  return { leadId: row.id };
}
