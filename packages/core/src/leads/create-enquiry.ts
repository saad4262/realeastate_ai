import { and, eq } from 'drizzle-orm';
import { lead, listing, type DbOrTx } from '@repo/db';
import { sql } from 'drizzle-orm';
import { leadAgentIdSql } from '../listings/scope';
import { publicListing } from '../listings/search-listings';
import { enquiryInputSchema, type EnquiryInput } from './lead-schema';
import { atomically, emitWorkflowEvent } from '../workflows/events';

export class EnquiryError extends Error {
  readonly field?: keyof EnquiryInput;
  constructor(message: string, field?: keyof EnquiryInput) {
    super(message);
    this.name = 'EnquiryError';
    this.field = field;
  }
}

/**
 * Record a public enquiry against a listing.
 *
 * The agency is resolved FROM THE LISTING, never taken from the caller. This
 * is the whole authorisation story for an endpoint that has no actor to ask
 * can() about: the browser chooses which listing it is writing to and nothing
 * else, and an id that is not a live listing is refused outright.
 *
 * Refusing on a non-live listing matters for more than tidiness. Accepting an
 * enquiry against a draft would confirm to anyone guessing ids that a draft
 * with that id exists, which is an agency's unpublished work.
 *
 * Returns the new lead's id. It is assigned to the listing's lead agent
 * straight away (ADR 0039 C3); status changes and reassignment are the
 * console's.
 */
export async function createEnquiry(
  db: DbOrTx,
  listingId: string,
  input: unknown,
): Promise<{ leadId: string }> {
  const parsed = enquiryInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new EnquiryError(
      first?.message ?? 'Check the highlighted fields',
      first?.path[0] as keyof EnquiryInput | undefined,
    );
  }

  const [target] = await db
    /**
     * The property as well as the agency, because a lead is anchored to the
     * address and not to the ad (docs/adr/0012). Both come from the listing;
     * neither is accepted from the browser.
     */
    .select({ agencyId: listing.agencyId, propertyId: listing.propertyId })
    .from(listing)
    // Live, and the agency not suspended (ADR 0050): a visitor cannot enquire about a hidden ad.
    .where(and(eq(listing.id, listingId), publicListing()))
    .limit(1);

  if (!target) throw new EnquiryError('That listing is no longer available');

  // The lead and its workflow event (ADR 0041), together or not at all.
  const row = await atomically(db, async (tx) => {
  const [made] = await tx
    .insert(lead)
    .values({
      propertyId: target.propertyId,
      listingId,
      agencyId: target.agencyId,
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone ?? null,
      message: parsed.data.message,
      // Set here rather than accepted from the browser. A caller choosing its
      // own status could file a lead as already closed.
      kind: 'enquiry',
      status: 'new',
      // ADR 0039 C3: the listing's lead agent has it from the start; the agency may move it later.
      assignedTo: leadAgentIdSql(sql`${listingId}::uuid`),
    })
    .returning({ id: lead.id, contactId: lead.contactId });
  if (made) {
    await emitWorkflowEvent(tx, { agencyId: target.agencyId, kind: 'lead.created', leadId: made.id, contactId: made.contactId, listingId, actor: null, data: { source: 'website' } });
  }
  return made;
  });

  if (!row) throw new EnquiryError('Could not record the enquiry');
  return { leadId: row.id };
}
