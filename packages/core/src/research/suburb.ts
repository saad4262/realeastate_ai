import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { listing, property, suburbCensus, type DbOrTx } from '@repo/db';
import { publicListing } from '../listings/search-listings';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { adFacts } from '../listings/facts';

/**
 * Suburb AI (ADR 0080, C5; mock docs/mocks/consumer-research.html, the seven decisions taken as recommended): what
 * this site's listings show about one suburb, and the ABS Census 2021 housing figures. Every figure is SQL or the
 * census table (#4). A median appears only when enough sales back it (decision 2), and every one of our figures is
 * labelled as this site's — never the whole market. No value, no prediction (decision 1).
 */

export const MEDIAN_MIN_SALES = 10;
export const MEDIAN_WINDOW_MONTHS = 12;
export const RECENT_SALES_SHOWN = 10;
export const CENSUS_SOURCE = { name: 'ABS, 2021 Census QuickStats (Suburbs and Localities)', url: 'https://www.abs.gov.au/census/find-census-data/quickstats/2021', checkedOn: '2026-11-03' } as const;

export type CensusView = {
  name: string;
  population: number | null;
  dwellings: number | null;
  /** Shares as whole percentages, computed here from the counts. Null when the census did not give the counts. */
  separateHousePct: number | null;
  semiDetachedPct: number | null;
  flatPct: number | null;
  ownedOutrightPct: number | null;
  ownedMortgagePct: number | null;
  rentedPct: number | null;
  medianRentWeekly: number | null;
  medianMortgageMonthly: number | null;
  avgHouseholdSize: number | null;
};

export type SuburbSale = { address: string; price: string; soldOn: Date; bedrooms: number | null; propertyType: string | null };

export type SuburbProfile = {
  suburb: string;
  state: string;
  forSale: number;
  forRent: number;
  salesInWindow: number;
  /** Null unless at least MEDIAN_MIN_SALES priced sales back it. */
  medianSold: { value: number; sales: number } | null;
  /** Null unless at least MEDIAN_MIN_SALES sales with a listing date back it. */
  medianDays: { value: number; sales: number } | null;
  recentSales: SuburbSale[];
  census: CensusView | null;
};

/** A whole percentage of `n` in `total`, or null without both. Pure. */
export function share(n: number | null, total: number | null): number | null {
  if (n === null || total === null || total <= 0) return null;
  return Math.round((n / total) * 100);
}

/** A median is shown only with enough sales behind it (decision 2). Pure. */
export function gatedMedian(value: number | null, sales: number): { value: number; sales: number } | null {
  return value !== null && sales >= MEDIAN_MIN_SALES ? { value: Math.round(value), sales } : null;
}

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

export function censusView(row: typeof suburbCensus.$inferSelect | undefined): CensusView | null {
  if (!row) return null;
  return {
    name: row.name,
    population: row.population,
    dwellings: row.dwellings,
    separateHousePct: share(row.separateHouses, row.dwellings),
    semiDetachedPct: share(row.semiDetached, row.dwellings),
    flatPct: share(row.flats, row.dwellings),
    ownedOutrightPct: share(row.ownedOutright, row.tenureTotal),
    ownedMortgagePct: share(row.ownedMortgage, row.tenureTotal),
    rentedPct: share(row.rented, row.tenureTotal),
    medianRentWeekly: row.medianRentWeekly,
    medianMortgageMonthly: row.medianMortgageMonthly,
    avgHouseholdSize: row.avgHouseholdSize === null ? null : Number(row.avgHouseholdSize),
  };
}

/** Sold, by an agency the public may see, in the window. The same rule for the count, the medians and the list. */
const soldIn = (suburb: string, state: string) =>
  and(
    eq(listing.status, 'sold'),
    sql`lower(${property.suburb}) = lower(${suburb})`,
    eq(property.state, state),
    sql`${listing.soldDate} >= now() - make_interval(months => ${MEDIAN_WINDOW_MONTHS})`,
    sql`${listing.agencyId} not in ${SUSPENDED_AGENCY_IDS}`,
  );

/** One suburb. Four reads: live counts, the window's sales and medians, the latest sales, the census row. Null for an unknown state. */
export async function suburbProfile(db: DbOrTx, ask: { state: string; suburb: string }): Promise<SuburbProfile | null> {
  const state = ask.state.trim().toUpperCase();
  const suburb = ask.suburb.trim().replace(/\s+/g, ' ');
  if (!/^(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)$/.test(state) || !suburb || suburb.length > 80) return null;

  const [[live], [stats], sales, [census]] = await Promise.all([
    db
      .select({ forSale: sql<number>`count(*) filter (where ${listing.channel} = 'sale')::int`, forRent: sql<number>`count(*) filter (where ${listing.channel} = 'rent')::int` })
      .from(listing)
      .innerJoin(property, eq(property.id, listing.propertyId))
      .where(and(publicListing(), sql`lower(${property.suburb}) = lower(${suburb})`, eq(property.state, state))),
    db
      .select({
        n: sql<number>`count(*)::int`,
        priced: sql<number>`count(${listing.soldPrice})::int`,
        medianSold: sql<string | null>`percentile_cont(0.5) within group (order by ${listing.soldPrice})`,
        dated: sql<number>`count(*) filter (where ${listing.publishedAt} is not null)::int`,
        // Counted by Postgres in days (#4): the listing date to the sale date.
        medianDays: sql<string | null>`percentile_cont(0.5) within group (order by (${listing.soldDate}::date - ${listing.publishedAt}::date)) filter (where ${listing.publishedAt} is not null)`,
      })
      .from(listing)
      .innerJoin(property, eq(property.id, listing.propertyId))
      .where(soldIn(suburb, state)),
    db
      .select({ street: sql<string>`concat_ws(' ', ${property.streetNumber}, ${property.street})`, soldPrice: listing.soldPrice, soldDate: listing.soldDate, bedrooms: adFacts.bedrooms, propertyType: adFacts.propertyType })
      .from(listing)
      .innerJoin(property, eq(property.id, listing.propertyId))
      .where(and(soldIn(suburb, state), isNotNull(listing.soldDate)))
      .orderBy(desc(listing.soldDate), desc(listing.id))
      .limit(RECENT_SALES_SHOWN),
    db.select().from(suburbCensus).where(and(eq(suburbCensus.state, state), eq(suburbCensus.nameKey, suburb.toLowerCase()))).limit(1),
  ]);

  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    suburb: census?.name ?? suburb.replace(/\b\w/g, (c) => c.toUpperCase()),
    state,
    forSale: Number(live?.forSale ?? 0),
    forRent: Number(live?.forRent ?? 0),
    salesInWindow: Number(stats?.n ?? 0),
    medianSold: gatedMedian(n(stats?.medianSold), Number(stats?.priced ?? 0)),
    medianDays: gatedMedian(n(stats?.medianDays), Number(stats?.dated ?? 0)),
    recentSales: sales.map((s) => ({
      address: s.street?.trim() || 'An address',
      price: s.soldPrice === null ? 'price not disclosed' : AUD.format(Number(s.soldPrice)),
      soldOn: s.soldDate!,
      bedrooms: s.bedrooms === null ? null : Number(s.bedrooms),
      propertyType: s.propertyType,
    })),
    census: censusView(census),
  };
}
