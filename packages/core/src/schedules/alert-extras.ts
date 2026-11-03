import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { listing, listingPriceChange, property, type DbOrTx } from '@repo/db';
import { publicListing } from '../listings/search-listings';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { priceText } from '../due-diligence/records';
import type { SavedSearchQuery } from '../listings/search-url';

/**
 * Smart Alerts' two extra sections (ADR 0080, C4 decision 6), both from SQL and both since the alert last emailed:
 * price changes on homes this alert already sent, and what sold in its suburb. Every figure is a stored value
 * formatted here (#4); the model's summary paragraph never sees either (its rules are unchanged, ADR 0080 #7).
 * Nothing on a first run — "since your last email" has no meaning yet.
 */

export const EXTRA_LIMIT = 8;

export type AlertExtras = {
  priceChanges: { listingId: string; address: string; text: string }[];
  sold: { address: string; price: string }[];
  /** The suburb the sales are from, for the heading. */
  suburb: string | null;
};

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const street = sql<string>`concat_ws(' ', ${property.streetNumber}, ${property.street})`;

export async function alertExtras(db: DbOrTx, input: { query: SavedSearchQuery; lastEmailedAt: Date | null; sentListingIds: readonly string[] }): Promise<AlertExtras> {
  const none: AlertExtras = { priceChanges: [], sold: [], suburb: null };
  if (!input.lastEmailedAt) return none;
  const since = input.lastEmailedAt;
  const ids = [...new Set(input.sentListingIds)].slice(0, 500);
  const suburb = input.query.suburb?.trim() || null;
  const wantSales = Boolean(suburb) && (input.query.channel ?? 'sale') === 'sale';

  const [changes, sold] = await Promise.all([
    ids.length
      ? db
          .select({ listingId: listingPriceChange.listingId, street, suburb: property.suburb, oldDisplay: listingPriceChange.oldDisplay, oldFrom: listingPriceChange.oldFrom, oldTo: listingPriceChange.oldTo, newDisplay: listingPriceChange.newDisplay, newFrom: listingPriceChange.newFrom, newTo: listingPriceChange.newTo })
          .from(listingPriceChange)
          .innerJoin(listing, eq(listing.id, listingPriceChange.listingId))
          .innerJoin(property, eq(property.id, listing.propertyId))
          // Only a home the buyer can still open.
          .where(and(inArray(listingPriceChange.listingId, ids), gt(listingPriceChange.changedAt, since), publicListing()))
          .orderBy(asc(listingPriceChange.changedAt), asc(listingPriceChange.id))
          .limit(EXTRA_LIMIT * 2)
      : Promise.resolve([]),
    wantSales
      ? db
          .select({ street, soldPrice: listing.soldPrice })
          .from(listing)
          .innerJoin(property, eq(property.id, listing.propertyId))
          .where(
            and(
              eq(listing.status, 'sold'),
              sql`lower(${property.suburb}) = lower(${suburb})`,
              ...(input.query.state ? [eq(property.state, input.query.state)] : []),
              // A sale is dated by day, so from the start of the day of the last email.
              sql`${listing.soldDate} >= date_trunc('day', ${since.toISOString()}::timestamptz)`,
              // The same rule every public read uses (ADR 0050).
              sql`${listing.agencyId} not in ${SUSPENDED_AGENCY_IDS}`,
            ),
          )
          .orderBy(sql`${listing.soldDate} desc`, asc(listing.id))
          .limit(EXTRA_LIMIT)
      : Promise.resolve([]),
  ]);

  // The latest change per home: two changes since the last email read as the second one.
  const latest = new Map<string, (typeof changes)[number]>();
  for (const c of changes) latest.set(c.listingId, c);
  return {
    priceChanges: [...latest.values()].slice(0, EXTRA_LIMIT).map((c) => ({
      listingId: c.listingId,
      address: [c.street?.trim(), c.suburb].filter(Boolean).join(', '),
      text: `from ${priceText(c.oldDisplay, c.oldFrom, c.oldTo)} to ${priceText(c.newDisplay, c.newFrom, c.newTo)}`,
    })),
    sold: sold.map((r) => ({ address: r.street?.trim() || 'An address', price: r.soldPrice === null ? 'price not disclosed' : AUD.format(Number(r.soldPrice)) })),
    suburb: wantSales ? suburb : null,
  };
}
