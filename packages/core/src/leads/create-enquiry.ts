import { and, eq } from 'drizzle-orm';
import { lead, listing, type DbOrTx } from '@repo/db';
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
    .select({ agencyId: listing.agencyId })
    .from(listing)
    .where(and(eq(listing.id, listingId), eq(listing.status, PUBLIC_STATUS)))
    .limit(1);

  if (!target) throw new EnquiryError('That listing is no longer available');

  const [row] = await db
    .insert(lead)
    .values({
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
    })
    .returning({ id: lead.id });

  if (!row) throw new EnquiryError('Could not record the enquiry');
  return { leadId: row.id };
}
