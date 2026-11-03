import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { listing, listingPriceChange, property, type DbOrTx } from '@repo/db';
import { publicListing } from '../listings/search-listings';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { adFacts } from '../listings/facts';
import { priceText } from '../due-diligence/records';
import { estimateStampDuty, type DutyEstimate } from '../affordability/stamp-duty';
import { AU_DUTY_STATES, type DutyState } from '../affordability/duty-rates';

/**
 * Comparison AI and Property Analyst (ADR 0080, C5 decisions 4 and 5): homes as rows of facts from SQL, never a value
 * (decision 1). A comparison is 2–4 PUBLIC listings; an explanation is one, with comparable homes listed — same
 * suburb, ±1 bedroom, sold or listed in the last 12 months — and never averaged into a price.
 */

export const MIN_COMPARE = 2;
export const MAX_COMPARE = 4;
export const MAX_COMPARABLES = 6;
export type BuyerType = 'first' | 'home' | 'investor';

export type HomeRow = {
  listingId: string;
  propertyId: string;
  address: string;
  suburb: string;
  state: string;
  channel: string;
  price: string;
  /** The top of the price, for the duty estimate; null without a numeric price (#6: the display string is never parsed). */
  priceForDuty: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  carSpaces: number | null;
  landAreaSqm: number | null;
  propertyType: string | null;
  daysOnMarket: number | null;
  priceChanges: string[];
  lastSale: string | null;
  stampDuty: DutyEstimate | null;
};

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const street = sql<string>`concat_ws(' ', ${property.streetNumber}, ${property.street})`;

/** The rows for public listings, in the order asked. Three reads for any number of homes. */
export async function homeRows(db: DbOrTx, listingIds: readonly string[], buyer: BuyerType): Promise<HomeRow[]> {
  const ids = [...new Set(listingIds)];
  if (!ids.length) return [];
  const rows = await db
    .select({
      listingId: listing.id,
      propertyId: listing.propertyId,
      street,
      suburb: property.suburb,
      state: property.state,
      channel: sql<string>`${listing.channel}::text`,
      priceDisplay: listing.priceDisplay,
      priceFrom: listing.priceFrom,
      priceTo: listing.priceTo,
      rentPw: listing.rentPw,
      bedrooms: adFacts.bedrooms,
      bathrooms: adFacts.bathrooms,
      carSpaces: adFacts.carSpaces,
      landAreaSqm: adFacts.landAreaSqm,
      propertyType: adFacts.propertyType,
      daysOnMarket: sql<number | null>`case when ${listing.publishedAt} is null then null else ((now() at time zone 'Australia/Sydney')::date - (${listing.publishedAt} at time zone 'Australia/Sydney')::date) end`,
    })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(and(inArray(listing.id, ids), publicListing()));
  if (!rows.length) return [];

  const [changes, sales] = await Promise.all([
    db
      .select({ listingId: listingPriceChange.listingId, oldDisplay: listingPriceChange.oldDisplay, oldFrom: listingPriceChange.oldFrom, oldTo: listingPriceChange.oldTo, newDisplay: listingPriceChange.newDisplay, newFrom: listingPriceChange.newFrom, newTo: listingPriceChange.newTo })
      .from(listingPriceChange)
      .where(inArray(listingPriceChange.listingId, rows.map((r) => r.listingId)))
      .orderBy(asc(listingPriceChange.changedAt), asc(listingPriceChange.id)),
    db
      .select({ propertyId: listing.propertyId, id: listing.id, soldPrice: listing.soldPrice, soldDate: listing.soldDate })
      .from(listing)
      .where(and(inArray(listing.propertyId, rows.map((r) => r.propertyId)), eq(listing.status, 'sold'), sql`${listing.agencyId} not in ${SUSPENDED_AGENCY_IDS}`))
      .orderBy(desc(listing.soldDate), desc(listing.id)),
  ]);

  const byId = new Map(
    rows.map((r) => {
      const state = (AU_DUTY_STATES as readonly string[]).includes(r.state) ? (r.state as DutyState) : null;
      const priceForDuty = r.channel === 'sale' ? n(r.priceTo) ?? n(r.priceFrom) : null;
      const last = sales.find((s) => s.propertyId === r.propertyId && s.id !== r.listingId);
      const row: HomeRow = {
        listingId: r.listingId,
        propertyId: r.propertyId,
        address: [r.street?.trim(), r.suburb].filter(Boolean).join(', '),
        suburb: r.suburb,
        state: r.state,
        channel: r.channel,
        price: r.channel === 'rent' && r.rentPw ? `${AUD.format(Number(r.rentPw))} per week` : priceText(r.priceDisplay, r.priceFrom, r.priceTo),
        priceForDuty,
        bedrooms: n(r.bedrooms),
        bathrooms: n(r.bathrooms),
        carSpaces: n(r.carSpaces),
        landAreaSqm: n(r.landAreaSqm),
        propertyType: r.propertyType,
        daysOnMarket: n(r.daysOnMarket),
        priceChanges: changes.filter((c) => c.listingId === r.listingId).map((c) => `${priceText(c.oldDisplay, c.oldFrom, c.oldTo)} → ${priceText(c.newDisplay, c.newFrom, c.newTo)}`),
        lastSale: last ? `${last.soldDate ? last.soldDate.toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' }) : 'Date unknown'} · ${last.soldPrice === null ? 'price not disclosed' : AUD.format(Number(last.soldPrice))}` : null,
        stampDuty:
          state && priceForDuty
            ? estimateStampDuty({ state, value: Math.round(priceForDuty), ownerOccupier: buyer !== 'investor', firstHome: buyer === 'first', propertyKind: 'established' })
            : null,
      };
      return [r.listingId, row] as const;
    }),
  );
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

export type Comparable = { listingId: string; address: string; bedrooms: number | null; landAreaSqm: number | null; standing: 'sold' | 'for_sale'; price: string };

/** Comparable homes for one public listing: same suburb and state, ±1 bedroom, sold or for sale in the last 12 months. Listed, never averaged. */
export async function comparables(db: DbOrTx, home: HomeRow): Promise<Comparable[]> {
  if (home.channel !== 'sale') return [];
  const beds = home.bedrooms;
  const rows = await db
    .select({ id: listing.id, street, status: sql<string>`${listing.status}::text`, bedrooms: adFacts.bedrooms, landAreaSqm: adFacts.landAreaSqm, soldPrice: listing.soldPrice, priceDisplay: listing.priceDisplay, priceFrom: listing.priceFrom, priceTo: listing.priceTo })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(
      and(
        ne(listing.propertyId, home.propertyId),
        eq(listing.channel, 'sale'),
        sql`lower(${property.suburb}) = lower(${home.suburb})`,
        eq(property.state, home.state),
        sql`${listing.agencyId} not in ${SUSPENDED_AGENCY_IDS}`,
        sql`((${listing.status} = 'sold' and ${listing.soldDate} >= now() - interval '12 months') or ${publicListing()})`,
        ...(beds === null ? [] : [sql`${adFacts.bedrooms} between ${beds - 1} and ${beds + 1}`]),
      ),
    )
    .orderBy(sql`coalesce(${listing.soldDate}, ${listing.publishedAt}) desc nulls last`, desc(listing.id))
    .limit(MAX_COMPARABLES);
  return rows.map((r) => ({
    listingId: r.id,
    address: r.street?.trim() || 'An address',
    bedrooms: n(r.bedrooms),
    landAreaSqm: n(r.landAreaSqm),
    standing: r.status === 'sold' ? 'sold' : 'for_sale',
    price: r.status === 'sold' ? (r.soldPrice === null ? 'Sold, not disclosed' : `Sold ${AUD.format(Number(r.soldPrice))}`) : `For sale ${priceText(r.priceDisplay, r.priceFrom, r.priceTo)}`,
  }));
}

/** Whether a listing is one the public may see — for an id that came from a browser. */
export async function isPublicListing(db: DbOrTx, listingId: string): Promise<boolean> {
  const [row] = await db.select({ id: listing.id }).from(listing).where(and(eq(listing.id, listingId), publicListing())).limit(1);
  return Boolean(row);
}

