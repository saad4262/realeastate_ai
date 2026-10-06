import { and, eq, sql } from 'drizzle-orm';
import { listing, type DbOrTx } from '@repo/db';

/**
 * What an import knows that the listing form does not ask (ADR 0029): the
 * agency's own id for the listing (re-import updates instead of duplicating),
 * and when it was first listed (so days on market stays honest). Called by the
 * import right after `createListing`, inside the same row savepoint, for a
 * listing of the importer's own agency.
 */
export async function setImportedListingFields(
  tx: DbOrTx,
  agencyId: string,
  listingId: string,
  fields: { externalId: string | null; listedOn: string | null },
): Promise<void> {
  await tx
    .update(listing)
    .set({
      ...(fields.externalId ? { externalId: fields.externalId } : {}),
      ...(fields.listedOn ? { publishedAt: new Date(`${fields.listedOn}T00:00:00Z`) } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(listing.id, listingId), eq(listing.agencyId, agencyId)));
}
