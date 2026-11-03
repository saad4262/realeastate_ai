import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { inspection, listing, property, type DbOrTx } from '@repo/db';
import { publicListing } from '../listings/search-listings';
import { adFacts } from '../listings/facts';
import { priceText } from '../due-diligence/records';
import { MAX_PLAN_HOMES, planAuto, planChosen, stateTimeZone, clampSettings, type DayPlan, type Distances, type PlanHome, type PlanSettings } from './plan';

/**
 * What a day plan is built from (C6 decisions 1–2): public listings, their upcoming OPEN times (private appointments
 * and auctions are not planned here), and the straight-line distance between each pair from PostGIS. Three reads,
 * whatever the number of homes.
 */

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function planHomes(db: DbOrTx, listingIds: readonly string[]): Promise<{ homes: PlanHome[]; distances: Distances }> {
  const ids = [...new Set(listingIds)].slice(0, MAX_PLAN_HOMES);
  if (!ids.length) return { homes: [], distances: () => null };
  const [rows, times, pairs] = await Promise.all([
    db
      .select({
        listingId: listing.id,
        street: sql<string>`concat_ws(' ', ${property.streetNumber}, ${property.street})`,
        suburb: property.suburb,
        state: property.state,
        postcode: property.postcode,
        priceDisplay: listing.priceDisplay,
        priceFrom: listing.priceFrom,
        priceTo: listing.priceTo,
        bedrooms: adFacts.bedrooms,
        propertyType: adFacts.propertyType,
      })
      .from(listing)
      .innerJoin(property, eq(property.id, listing.propertyId))
      .where(and(inArray(listing.id, ids), publicListing())),
    db
      .select({ id: inspection.id, listingId: inspection.listingId, startsAt: inspection.startsAt, endsAt: inspection.endsAt })
      .from(inspection)
      .where(and(inArray(inspection.listingId, ids), eq(inspection.kind, 'open'), gte(inspection.endsAt, sql`now()`)))
      .orderBy(asc(inspection.startsAt), asc(inspection.id)),
    db.execute<{ a: string; b: string; metres: string | null }>(sql`
      select la.id as a, lb.id as b, ST_Distance(pa.geom, pb.geom) as metres
      from listing la join property pa on pa.id = la.property_id,
           listing lb join property pb on pb.id = lb.property_id
      where la.id in ${ids} and lb.id in ${ids} and la.id < lb.id`),
  ]);

  const metres = new Map<string, number | null>();
  for (const p of pairs as unknown as { a: string; b: string; metres: string | null }[]) metres.set(`${p.a}|${p.b}`, num(p.metres));
  const distances: Distances = (a, b) => (a < b ? metres.get(`${a}|${b}`) : metres.get(`${b}|${a}`)) ?? null;

  const byId = new Map(
    rows.map((r) => {
      const street = r.street?.trim();
      const home: PlanHome = {
        listingId: r.listingId,
        address: [street, r.suburb].filter(Boolean).join(', '),
        mapAddress: [street, `${r.suburb} ${r.state} ${r.postcode}`.trim()].filter(Boolean).join(', '),
        state: r.state,
        price: priceText(r.priceDisplay, r.priceFrom, r.priceTo),
        bedrooms: num(r.bedrooms),
        propertyType: r.propertyType,
        sessions: times.filter((t) => t.listingId === r.listingId).map((t) => ({ id: t.id, startsAt: t.startsAt, endsAt: t.endsAt })),
      };
      return [r.listingId, home] as const;
    }),
  );
  return { homes: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])), distances };
}

export type PlanAsk = { listingIds: string[]; sessionIds?: string[]; day?: string | null; settings?: Partial<PlanSettings> };

/** A plan for public homes: the buyer's chosen times when given, otherwise the planner picks. Null with no public home. */
export async function buildPlan(db: DbOrTx, ask: PlanAsk): Promise<DayPlan | null> {
  const { homes, distances } = await planHomes(db, ask.listingIds);
  if (!homes.length) return null;
  const settings = clampSettings(ask.settings);
  const timeZone = stateTimeZone(homes[0]!.state);
  const day = ask.day && /^\d{4}-\d{2}-\d{2}$/.test(ask.day) ? ask.day : null;
  return ask.sessionIds?.length ? planChosen(homes, ask.sessionIds, { settings, distances, timeZone }) : planAuto(homes, { day, settings, distances, timeZone });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (v: unknown, max: number) =>
  (typeof v === 'string' ? v.split(',') : [])
    .map((s) => s.trim())
    .filter((s) => UUID.test(s))
    .slice(0, max);

/** A plan's link (`?l=…&s=…&day=…&gap=…&inside=…`) as a request; null without a single valid home. Pure. */
export function parsePlanLink(params: Record<string, string | string[] | undefined>): PlanAsk | null {
  const listingIds = ids(params.l, MAX_PLAN_HOMES);
  if (!listingIds.length) return null;
  const sessionIds = ids(params.s, MAX_PLAN_HOMES * 4);
  const day = typeof params.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : null;
  return { listingIds, ...(sessionIds.length ? { sessionIds } : {}), day, settings: { gapMinutes: Number(params.gap), insideMinutes: Number(params.inside) } };
}
