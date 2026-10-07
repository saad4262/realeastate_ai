import { and, eq, sql } from 'drizzle-orm';
import { lead, listing, type DbOrTx } from '@repo/db';
import { assignIfUnowned, primaryAgentSql } from '../contacts/auto-assign';
import { enquiryInputSchema, type EnquiryInput } from './lead-schema';

/** Live only — the same status the public search and listing page use. */
const PUBLIC_STATUS = 'live' as const;

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
 * Returns the new lead's id. Everything the console needs to triage it —
 * status, assignment, the AI summary — is set by the console, not here.
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
     * neither is accepted from the browser. So does who it goes to: the
     * listing's primary agent (the client's rule, 2026-10-07).
     */
    .select({ agencyId: listing.agencyId, propertyId: listing.propertyId, agent: sql<string | null>`${primaryAgentSql(sql`${listing.id}`)}` })
    .from(listing)
    .where(and(eq(listing.id, listingId), eq(listing.status, PUBLIC_STATUS)))
    .limit(1);

  if (!target) throw new EnquiryError('That listing is no longer available');

  // The lead and, if the person is nobody's yet, their contact go straight to the listing's
  // primary agent — not to the agency's queue. Someone else's contact stays theirs; the new
  // agent reads it through the lead. Nobody active on the listing: the owner/admin queue.
  return db.transaction(async (tx) => {
  const [row] = await tx
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
      assignedTo: target.agent ?? null,
    })
    .returning({ id: lead.id, contactId: lead.contactId });

  if (!row) throw new EnquiryError('Could not record the enquiry');
  if (target.agent && row.contactId) await assignIfUnowned(tx, target.agencyId, [row.contactId], target.agent, 'enquiry');
  return { leadId: row.id };
  });
}
