import { sql, type SQL } from 'drizzle-orm';
import type { RequirementChannel } from '../contacts/contact-schema';

/**
 * Which buyers' briefs fit a property (ADR 0059 §2, ADR 0060 §2) — the ONE rule, read by the assistant's
 * find_buyers, a listing's Matching buyers tab and the Listings table's Buyers count, so they always agree.
 * A brief fits when the property would suit it: same sale or rent; the price ranges overlap (an open end on
 * either side is open); it needs no more bedrooms or bathrooms than the property has; the property's suburb
 * and type are among the brief's, an empty list meaning any. Whatever the property does not state is not
 * checked. Pure: SQL fragments only, over `br` (buyer_requirement).
 */

/** A property described in words. A null field is not checked. */
export type BuyerTarget = {
  channel: RequirementChannel;
  suburb: string | null;
  /** The property's price as a range; an open end is null. Per week for rent. */
  low: number | null;
  high: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  propertyType: string | null;
  /** Listing mode: its address, and whether its price was stated. */
  address?: string;
  priceUnknown?: boolean;
};

/** One side of a comparison: a value, and whether it may be null at run time (a column) or not (a given value). */
type Side = { v: SQL; nullable: boolean } | null;
export type FitExprs = { channel: SQL; low: Side; high: Side; bedrooms: Side; bathrooms: Side; suburb: Side; propertyType: Side };

/** `body` only when the property states the value: a column that is null checks nothing. */
const when = (s: NonNullable<Side>, body: SQL) => (s.nullable ? sql`(${s.v} is null or ${body})` : body);

export function briefFitsSql(e: FitExprs): SQL[] {
  const w: SQL[] = [sql`br.status = 'active'`, sql`br.channel::text = ${e.channel}`];
  if (e.high) w.push(when(e.high, sql`(br.price_min is null or br.price_min <= ${e.high.v})`));
  if (e.low) w.push(when(e.low, sql`(br.price_max is null or br.price_max >= ${e.low.v})`));
  if (e.bedrooms) w.push(when(e.bedrooms, sql`(br.min_bedrooms is null or br.min_bedrooms <= ${e.bedrooms.v})`));
  if (e.bathrooms) w.push(when(e.bathrooms, sql`(br.min_bathrooms is null or br.min_bathrooms <= ${e.bathrooms.v})`));
  if (e.suburb) w.push(when(e.suburb, sql`(cardinality(br.suburbs) = 0 or exists (select 1 from unnest(br.suburbs) s where lower(s) = lower(${e.suburb.v})))`));
  if (e.propertyType) w.push(when(e.propertyType, sql`(cardinality(br.property_types) = 0 or lower(${e.propertyType.v}) = any (br.property_types))`));
  return w;
}

/** A property in words, as given values. */
export function targetExprs(t: BuyerTarget): FitExprs {
  const given = (v: unknown): Side => (v === null || v === undefined ? null : { v: sql`${v}`, nullable: false });
  return {
    channel: sql`${t.channel}`,
    low: given(t.low),
    high: given(t.high),
    bedrooms: given(t.bedrooms),
    bathrooms: given(t.bathrooms),
    suburb: given(t.suburb),
    propertyType: given(t.propertyType),
  };
}

/** Sale or rent, from a listing's channel: a sold listing was a sale, a leased one a rental. */
export const LISTING_CHANNEL = sql`(case when li.channel::text in ('rent', 'leased') then 'rent' else 'sale' end)`;

/** The listing's price as one range `pr(low, high)` — needs `li` in scope. Rent reads rent_pw. */
export const LISTING_PRICE_RANGE = sql`cross join lateral (
  select
    case when li.channel::text in ('rent', 'leased') then li.rent_pw else coalesce(li.price_from, li.price_to) end as low,
    case when li.channel::text in ('rent', 'leased') then li.rent_pw else coalesce(li.price_to, li.price_from) end as high
) pr`;

/** A listing's own figures, as columns: `li` listing, `p` its property, `pr` LISTING_PRICE_RANGE. */
export const LISTING_EXPRS: FitExprs = {
  channel: LISTING_CHANNEL,
  low: { v: sql`pr.low`, nullable: true },
  high: { v: sql`pr.high`, nullable: true },
  // ADR 0075: the listing's own facts, the address's where the ad leaves one blank.
  bedrooms: { v: sql`coalesce(li.bedrooms, p.bedrooms)`, nullable: true },
  bathrooms: { v: sql`coalesce(li.bathrooms, p.bathrooms)`, nullable: true },
  suburb: { v: sql`p.suburb`, nullable: true },
  propertyType: { v: sql`coalesce(li.property_type, p.property_type)`, nullable: true },
};

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

/** What was searched for, in words — above the results, and to the model. Pure. */
export function describeTarget(t: BuyerTarget): string {
  const per = t.channel === 'rent' ? '/wk' : '';
  const f = (n: number) => `${AUD.format(n)}${per}`;
  const price =
    t.low !== null && t.high !== null
      ? t.low === t.high ? f(t.low) : `${f(t.low)} – ${f(t.high)}`
      : t.high !== null ? `up to ${f(t.high)}` : t.low !== null ? `from ${f(t.low)}` : null;
  const parts = [t.channel === 'rent' ? 'Renting' : 'Buying'];
  if (t.address) parts.push(t.address);
  if (price) parts.push(price);
  else if (t.priceUnknown) parts.push('price not stated, so budgets were not checked');
  if (t.bedrooms !== null) parts.push(`${t.bedrooms} bed`);
  if (t.bathrooms !== null) parts.push(`${t.bathrooms} bath`);
  if (t.propertyType) parts.push(t.propertyType.charAt(0).toUpperCase() + t.propertyType.slice(1));
  if (!t.address) parts.push(t.suburb ?? 'any suburb');
  return parts.join(' · ');
}
