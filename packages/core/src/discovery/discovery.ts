import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { discoveryHidden, property, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { PUBLIC_STATUS } from '../listings/search-listings';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { factSql } from '../listings/facts';
import { priceText } from '../due-diligence/records';
import { loadProfile } from '../profile/profile';
import {
  CANDIDATE_LIMIT,
  DISCOVERY_RADIUS_METRES,
  MAX_FOR_YOU,
  MAX_HIDDEN,
  MAX_NOT_FOR_SALE,
  MAX_SIMILAR,
  NOT_FOR_SALE_AFTER_MONTHS,
  SIMILAR_PRICE_BAND,
  askSummary,
  profileAsk,
  rankSuggestions,
  type CandidateRow,
  type DiscoveryAsk,
  type ProfileGap,
  type Suggestion,
} from './match';

/**
 * Discovery AI (ADR 0080, C7 decisions 1–4). Two starting points, both explicit: a public listing's own details
 * (Similar homes — no personal data, the same for every visitor) or the buyer's Personal Property AI profile while it
 * is on (For you). Postgres applies the hard filters; `rankSuggestions` decides what each card says. Nothing here is
 * stored except what a buyer hid, and nothing an agency can read.
 */

export class DiscoveryError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'not_found' | 'limit',
    message: string,
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

function require(actor: Actor, action: 'discovery_hidden:read' | 'discovery_hidden:manage') {
  if (!can(actor, action, { type: 'discovery_hidden', ownerId: actor.userId })) throw new DiscoveryError('forbidden', 'Sign in to see your suggestions.');
}

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

/** A rental's price is a week's rent; a sale's is its range. Never parsed from the display string (#6). */
function cardPrice(channel: string, display: string | null, from: unknown, to: unknown, rentPw: unknown): string {
  if (channel === 'rent') return display?.trim() || (rentPw === null || rentPw === undefined ? 'no price shown' : `${AUD.format(Number(rentPw))} a week`);
  return priceText(display, from as string | null, to as string | null);
}

const L_BEDS = factSql('bedrooms', 'l', 'p');
const L_BATHS = factSql('bathrooms', 'l', 'p');
const L_TYPE = factSql('property_type', 'l', 'p');
/** The street part of an address, unit first ("2/6 Henry Street"), for the alias `p`. */
const STREET = sql`nullif(trim(concat(case when p.unit is not null then p.unit || '/' end, concat_ws(' ', p.street_number, p.street))), '')`;
const TOP_PRICE = sql`case when l.channel = 'rent' then l.rent_pw else coalesce(l.price_to, l.price_from) end`;

type RawCandidate = {
  listing_id: string;
  property_id: string;
  street: string | null;
  suburb: string;
  state: string;
  channel: string;
  price_display: string | null;
  price_from: string | null;
  price_to: string | null;
  rent_pw: string | null;
  top_price: string | null;
  bedrooms: number | string | null;
  bathrooms: string | null;
  property_type: string | null;
  in_suburb: boolean;
  near_name: string | null;
  near_metres: number | string | null;
  published_at: Date | string | null;
};

/**
 * One read: public listings in the channel and kinds, within budget (or without a price), in the asked suburbs or
 * within 5 km of an anchor, not hidden by this buyer. The anchors are the listing itself, or the middle of this
 * site's addresses in each of the profile's suburbs.
 */
async function candidates(db: DbOrTx, ask: DiscoveryAsk, opts: { anchorPropertyId?: string; excludePropertyId?: string; userId?: string }): Promise<CandidateRow[]> {
  const anchors = opts.anchorPropertyId
    ? sql`select ap.suburb as name, ap.geom as centre from property ap where ap.id = ${opts.anchorPropertyId} and ap.geom is not null`
    : sql`select min(ap.suburb) as name, ST_Centroid(ST_Collect(ap.geom::geometry))::geography as centre
          from property ap where lower(ap.suburb) in ${ask.suburbs} and ap.geom is not null group by lower(ap.suburb), ap.state`;
  const inSuburb = sql`(lower(p.suburb) in ${ask.suburbs}${ask.state ? sql` and p.state = ${ask.state}` : sql``})`;
  const filters: SQL[] = [
    sql`l.status = ${PUBLIC_STATUS}`,
    sql`l.agency_id not in ${SUSPENDED_AGENCY_IDS}`,
    sql`l.channel = ${ask.channel}`,
    sql`(${inSuburb} or near.metres <= ${DISCOVERY_RADIUS_METRES})`,
  ];
  if (opts.excludePropertyId) filters.push(sql`l.property_id <> ${opts.excludePropertyId}`);
  if (ask.propertyTypes.length) filters.push(sql`lower(${L_TYPE}) in ${ask.propertyTypes}`);
  if (ask.bedrooms !== null) filters.push(sql`${L_BEDS} in (${ask.bedrooms}, ${ask.bedrooms + 1})`);
  if (ask.priceTo !== null) filters.push(sql`(${TOP_PRICE} is null or ${TOP_PRICE} <= ${ask.priceTo})`);
  if (ask.priceNear !== null) filters.push(sql`(${TOP_PRICE} is null or ${TOP_PRICE} between ${ask.priceNear * (1 - SIMILAR_PRICE_BAND)} and ${ask.priceNear * (1 + SIMILAR_PRICE_BAND)})`);
  if (opts.userId) filters.push(sql`not exists (select 1 from discovery_hidden h where h.user_id = ${opts.userId} and h.property_id = l.property_id)`);

  const rows = (await db.execute(sql`
    with anchors as (${anchors})
    select l.id as listing_id, l.property_id, ${STREET} as street, p.suburb, p.state,
           l.channel::text as channel, l.price_display, l.price_from, l.price_to, l.rent_pw, ${TOP_PRICE} as top_price,
           ${L_BEDS} as bedrooms, ${L_BATHS} as bathrooms, ${L_TYPE} as property_type,
           ${inSuburb} as in_suburb, near.name as near_name, near.metres as near_metres, l.published_at
    from listing l
    join property p on p.id = l.property_id
    left join lateral (
      select a.name, ST_Distance(a.centre, p.geom) as metres from anchors a where p.geom is not null order by ST_Distance(a.centre, p.geom) limit 1
    ) near on true
    where ${sql.join(filters, sql` and `)}
    order by l.published_at desc nulls last, l.id
    limit ${CANDIDATE_LIMIT}`)) as unknown as RawCandidate[];

  return rows.map((r) => ({
    listingId: r.listing_id,
    propertyId: r.property_id,
    address: [r.street?.trim(), r.suburb].filter(Boolean).join(', '),
    suburb: r.suburb,
    state: r.state,
    price: cardPrice(r.channel, r.price_display, r.price_from, r.price_to, r.rent_pw),
    topPrice: num(r.top_price),
    bedrooms: num(r.bedrooms),
    bathrooms: num(r.bathrooms),
    propertyType: r.property_type,
    inSuburb: Boolean(r.in_suburb),
    nearName: r.near_name,
    nearMetres: num(r.near_metres),
    publishedAt: date(r.published_at),
  }));
}

export type SimilarHomes = { listingId: string; ask: DiscoveryAsk; homes: Suggestion[] };

/**
 * Similar homes for one PUBLIC listing (decision 1): its suburb, kind, bedrooms and price, nothing about the visitor —
 * the same list for everyone. Null when the listing is not public. Two reads.
 */
export async function similarHomes(db: DbOrTx, listingId: string): Promise<SimilarHomes | null> {
  const [subject] = (await db.execute(sql`
    select l.property_id, l.channel::text as channel, p.suburb, p.state, ${L_BEDS} as bedrooms, ${L_TYPE} as property_type, ${TOP_PRICE} as top_price
    from listing l join property p on p.id = l.property_id
    where l.id = ${listingId} and l.status = ${PUBLIC_STATUS} and l.agency_id not in ${SUSPENDED_AGENCY_IDS}
    limit 1`)) as unknown as { property_id: string; channel: string; suburb: string; state: string; bedrooms: number | string | null; property_type: string | null; top_price: string | null }[];
  if (!subject || (subject.channel !== 'sale' && subject.channel !== 'rent')) return null;
  const ask: DiscoveryAsk = {
    from: 'listing',
    channel: subject.channel,
    suburbs: [subject.suburb.toLowerCase()],
    state: subject.state,
    propertyTypes: subject.property_type ? [subject.property_type.toLowerCase()] : [],
    bedrooms: num(subject.bedrooms),
    priceTo: null,
    priceNear: num(subject.top_price),
  };
  const rows = await candidates(db, ask, { anchorPropertyId: subject.property_id, excludePropertyId: subject.property_id });
  return { listingId, ask, homes: rankSuggestions(rows, ask, MAX_SIMILAR) };
}

export type NotForSaleHome = { propertyId: string; address: string; suburb: string; state: string; bedrooms: number | null; propertyType: string | null; soldOn: Date; soldText: string };

const MONTH = new Intl.DateTimeFormat('en-AU', { month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });

/**
 * Homes not for sale (decision 3): addresses this site SOLD, the latest sale at least 12 months ago, nothing on the
 * market or being prepared there now, in the profile's own suburbs and kind. At most 3; never mixed with homes for
 * sale. A sale by a suspended agency is left out — its private offer has nowhere to go. One read.
 */
export async function notForSaleHomes(db: DbOrTx, ask: DiscoveryAsk, userId: string | null): Promise<NotForSaleHome[]> {
  if (ask.channel !== 'sale' || !ask.suburbs.length) return [];
  const filters: SQL[] = [
    sql`lower(p.suburb) in ${ask.suburbs}`,
    sql`s.sold_date <= now() - make_interval(months => ${NOT_FOR_SALE_AFTER_MONTHS})`,
    sql`s.agency_id not in ${SUSPENDED_AGENCY_IDS}`,
    sql`not exists (select 1 from listing y where y.property_id = p.id and y.status in ('draft', 'pending', 'live', 'under_offer'))`,
  ];
  if (ask.propertyTypes.length) filters.push(sql`lower(s.property_type) in ${ask.propertyTypes}`);
  if (ask.bedrooms !== null) filters.push(sql`s.bedrooms = ${ask.bedrooms}`);
  if (userId) filters.push(sql`not exists (select 1 from discovery_hidden h where h.user_id = ${userId} and h.property_id = p.id)`);
  const rows = (await db.execute(sql`
    select p.id as property_id, ${STREET} as street, p.suburb, p.state, s.sold_date, s.bedrooms, s.property_type
    from property p
    join lateral (
      select x.sold_date, x.agency_id, coalesce(x.bedrooms, p.bedrooms) as bedrooms, coalesce(x.property_type, p.property_type) as property_type
      from listing x where x.property_id = p.id and x.status = 'sold' and x.sold_date is not null
      order by x.sold_date desc, x.id desc limit 1
    ) s on true
    where ${sql.join(filters, sql` and `)}
    order by s.sold_date desc, p.id
    limit ${MAX_NOT_FOR_SALE}`)) as unknown as { property_id: string; street: string | null; suburb: string; state: string; sold_date: Date | string; bedrooms: number | string | null; property_type: string | null }[];
  return rows.map((r) => {
    const soldOn = date(r.sold_date)!;
    return {
      propertyId: r.property_id,
      address: [r.street?.trim(), r.suburb].filter(Boolean).join(', '),
      suburb: r.suburb,
      state: r.state,
      bedrooms: num(r.bedrooms),
      propertyType: r.property_type,
      soldOn,
      soldText: MONTH.format(soldOn),
    };
  });
}

export type ForYou =
  | { state: 'profile_off' }
  | { state: 'gap'; gap: ProfileGap }
  | { state: 'ready'; ask: DiscoveryAsk; summary: { label: string; value: string }[]; homes: Suggestion[]; notForSale: NotForSaleHome[] };

/** For you (decision 1): from the buyer's profile while Personal Property AI is on, never from what they viewed. */
export async function forYou(db: DbOrTx, actor: Actor, env: Record<string, string | undefined> = process.env): Promise<ForYou> {
  require(actor, 'discovery_hidden:read');
  const profile = await loadProfile(db, actor, env);
  if (!profile.on) return { state: 'profile_off' };
  const built = profileAsk(profile.facts);
  if ('gap' in built) return { state: 'gap', gap: built.gap };
  const { ask } = built;
  const [rows, notForSale] = await Promise.all([candidates(db, ask, { userId: actor.userId }), notForSaleHomes(db, ask, actor.userId)]);
  return { state: 'ready', ask, summary: askSummary(ask), homes: rankSuggestions(rows, ask, MAX_FOR_YOU), notForSale };
}

/** "Not for me" (decision 4): an ADDRESS, so a relisted home stays hidden. Hides only; teaches the profile nothing. */
export async function hideHome(db: DbOrTx, actor: Actor, propertyId: string): Promise<void> {
  require(actor, 'discovery_hidden:manage');
  const [[found], [{ n } = { n: 0 }]] = await Promise.all([
    db.select({ id: property.id }).from(property).where(eq(property.id, propertyId)).limit(1),
    db.select({ n: sql<number>`count(*)::int` }).from(discoveryHidden).where(eq(discoveryHidden.userId, actor.userId)),
  ]);
  if (!found) throw new DiscoveryError('not_found', 'That home could not be found.');
  if (Number(n) >= MAX_HIDDEN) throw new DiscoveryError('limit', `Up to ${MAX_HIDDEN} hidden homes. Show some again first.`);
  await db.insert(discoveryHidden).values({ userId: actor.userId, propertyId }).onConflictDoNothing();
}

export async function showHomeAgain(db: DbOrTx, actor: Actor, propertyId: string): Promise<void> {
  require(actor, 'discovery_hidden:manage');
  await db.delete(discoveryHidden).where(and(eq(discoveryHidden.userId, actor.userId), eq(discoveryHidden.propertyId, propertyId)));
}

export async function clearHiddenHomes(db: DbOrTx, actor: Actor): Promise<void> {
  require(actor, 'discovery_hidden:manage');
  await db.delete(discoveryHidden).where(eq(discoveryHidden.userId, actor.userId));
}

/** The buyer's hidden homes, newest first, with the address to show. One read. */
export async function hiddenHomes(db: DbOrTx, actor: Actor): Promise<{ propertyId: string; address: string }[]> {
  require(actor, 'discovery_hidden:read');
  const rows = await db
    .select({ propertyId: discoveryHidden.propertyId, street: sql<string | null>`nullif(trim(concat(case when ${property.unit} is not null then ${property.unit} || '/' end, concat_ws(' ', ${property.streetNumber}, ${property.street}))), '')`, suburb: property.suburb })
    .from(discoveryHidden)
    .innerJoin(property, eq(property.id, discoveryHidden.propertyId))
    .where(eq(discoveryHidden.userId, actor.userId))
    .orderBy(desc(discoveryHidden.createdAt))
    .limit(MAX_HIDDEN);
  return rows.map((r) => ({ propertyId: r.propertyId, address: [r.street?.trim(), r.suburb].filter(Boolean).join(', ') }));
}
