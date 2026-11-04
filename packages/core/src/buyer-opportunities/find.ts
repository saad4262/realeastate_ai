import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import { PUBLIC_STATUS } from '../listings/search-listings';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { factSql } from '../listings/facts';
import { priceText } from '../due-diligence/records';
import type { ProfileFacts } from '../profile/derive';
import { AU_STATES, propertyTypeSchema } from '../listings/listing-schema';
import {
  LONG_CAMPAIGN_DAYS,
  MAX_OPPORTUNITIES,
  MAX_SUBURBS,
  MEDIAN_MIN_SALES,
  MEDIAN_WINDOW_MONTHS,
  OPPORTUNITY_CANDIDATES,
  SIGNAL_KINDS,
  emptyReason,
  type Signal,
  type SignalKind,
} from './signals';

/**
 * Opportunity AI's reads (ADR 0080, C7 decisions 5, 7 and 8). Homes FOR SALE only, public, in an area the buyer names;
 * each signal decided by Postgres from the listing's own records — its newest price change, the days since this
 * campaign was published, and the median sale for the same suburb, kind and bedroom count with 10+ sales in 12 months.
 * Three reads, whatever the area.
 */

export type OpportunityAsk = {
  /** Lower-cased; with `state`, the area. At least one of the two. */
  suburbs: string[];
  state: string | null;
  /** The top of the asking price at or under this; a home with no price is left out (nothing to compare). */
  priceTo: number | null;
  /** At least this many bedrooms. */
  bedrooms: number | null;
  propertyType: string | null;
  /** Which signals to show; the counts are for all three. */
  signals: SignalKind[];
};

export type OpportunityHome = {
  listingId: string;
  propertyId: string;
  address: string;
  suburb: string;
  state: string;
  price: string;
  bedrooms: number | null;
  bathrooms: number | null;
  propertyType: string | null;
  signals: Signal[];
};

export type Opportunities = {
  area: string;
  homes: OpportunityHome[];
  /** Homes in the area with each signal, whichever are chosen. */
  counts: Record<SignalKind, number>;
  /** Why a signal with no homes has none. */
  emptyWhy: Partial<Record<SignalKind, string>>;
  medianDaysOnMarket: number | null;
  /** More homes had a signal than were read; the page says the list is the newest of them. */
  truncated: boolean;
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** "Pakenham, Officer" or "VIC". Pure. */
export function areaText(ask: Pick<OpportunityAsk, 'suburbs' | 'state'>): string {
  if (ask.suburbs.length) return ask.suburbs.map(title).join(', ') + (ask.state ? ` ${ask.state}` : '');
  return ask.state ?? 'this area';
}

const L_BEDS = factSql('bedrooms', 'l', 'p');
const L_BATHS = factSql('bathrooms', 'l', 'p');
const L_TYPE = factSql('property_type', 'l', 'p');
const STREET = sql`nullif(trim(concat(case when p.unit is not null then p.unit || '/' end, concat_ws(' ', p.street_number, p.street))), '')`;
const DAYS = sql`((now() at time zone 'Australia/Sydney')::date - (l.published_at at time zone 'Australia/Sydney')::date)`;
const SOLD_IN_WINDOW = sql`s.status = 'sold' and s.sold_price is not null and s.sold_date >= now() - make_interval(months => ${MEDIAN_WINDOW_MONTHS}) and s.agency_id not in ${SUSPENDED_AGENCY_IDS}`;

type Raw = {
  listing_id: string;
  property_id: string;
  street: string | null;
  suburb: string;
  state: string;
  price_display: string | null;
  price_from: string | null;
  price_to: string | null;
  bedrooms: number | string | null;
  bathrooms: string | null;
  property_type: string | null;
  published_at: Date | string | null;
  days: number | string | null;
  changed_at: Date | string | null;
  old_display: string | null;
  old_from: string | null;
  old_to: string | null;
  new_display: string | null;
  new_from: string | null;
  new_to: string | null;
  lower_by: string | null;
  asking_from: string | null;
  median: number | string | null;
  sales: number | string | null;
};

/** The signals one row has, decided from what Postgres computed. Pure; exported for the tests. */
export function signalsOfRow(r: Raw): Signal[] {
  const out: Signal[] = [];
  const lowerBy = num(r.lower_by);
  if (r.changed_at && lowerBy !== null && lowerBy > 0) {
    out.push({ kind: 'price_reduced', on: date(r.changed_at)!, fromText: priceText(r.old_display, r.old_from, r.old_to), toText: priceText(r.new_display, r.new_from, r.new_to), lowerBy });
  }
  const days = num(r.days);
  if (days !== null && days >= LONG_CAMPAIGN_DAYS && r.published_at) out.push({ kind: 'long_campaign', days, since: date(r.published_at)! });
  const sales = num(r.sales) ?? 0;
  const median = num(r.median);
  const asking = num(r.asking_from);
  const beds = num(r.bedrooms);
  if (sales >= MEDIAN_MIN_SALES && median !== null && asking !== null && asking < median && beds !== null && r.property_type) {
    out.push({ kind: 'below_median', askingFrom: asking, median: Math.round(median), sales, bedrooms: beds, propertyType: r.property_type, suburb: r.suburb });
  }
  return out;
}

export type RawOpportunityRow = Raw;

export async function findOpportunities(db: DbOrTx, ask: OpportunityAsk): Promise<Opportunities> {
  const area = areaText(ask);
  const where: SQL[] = [sql`l.status = ${PUBLIC_STATUS}`, sql`l.agency_id not in ${SUSPENDED_AGENCY_IDS}`, sql`l.channel = 'sale'`];
  if (ask.suburbs.length) where.push(sql`lower(p.suburb) in ${ask.suburbs}`);
  if (ask.state) where.push(sql`p.state = ${ask.state}`);
  if (ask.priceTo !== null) where.push(sql`coalesce(l.price_to, l.price_from) <= ${ask.priceTo}`);
  if (ask.bedrooms !== null) where.push(sql`${L_BEDS} >= ${ask.bedrooms}`);
  if (ask.propertyType) where.push(sql`lower(${L_TYPE}) = ${ask.propertyType}`);
  const areaOnly: SQL[] = [];
  if (ask.suburbs.length) areaOnly.push(sql`lower(sp.suburb) in ${ask.suburbs}`);
  if (ask.state) areaOnly.push(sql`sp.state = ${ask.state}`);

  const [rows, [market], [groups]] = await Promise.all([
    db.execute(sql`
      with base as (
        select l.id as listing_id, l.property_id, ${STREET} as street, p.suburb, p.state,
               l.price_display, l.price_from, l.price_to, ${L_BEDS} as bedrooms, ${L_BATHS} as bathrooms, ${L_TYPE} as property_type,
               l.published_at, case when l.published_at is null then null else ${DAYS} end as days,
               pc.changed_at, pc.old_display, pc.old_from, pc.old_to, pc.new_display, pc.new_from, pc.new_to,
               -- The low end before and after the newest change: "Contact agent" to a number has no "before", so it is no reduction.
               coalesce(pc.old_from, pc.old_to) - coalesce(pc.new_from, pc.new_to) as lower_by,
               coalesce(l.price_from, l.price_to) as asking_from,
               med.median, med.sales
        from listing l
        join property p on p.id = l.property_id
        left join lateral (
          select c.changed_at, c.old_display, c.old_from, c.old_to, c.new_display, c.new_from, c.new_to
          from listing_price_change c where c.listing_id = l.id order by c.changed_at desc, c.id desc limit 1
        ) pc on true
        left join lateral (
          select percentile_cont(0.5) within group (order by s.sold_price) as median, count(*)::int as sales
          from listing s join property sp on sp.id = s.property_id
          where ${SOLD_IN_WINDOW}
            and lower(sp.suburb) = lower(p.suburb) and sp.state = p.state
            and lower(${factSql('property_type', 's', 'sp')}) = lower(${L_TYPE})
            and ${factSql('bedrooms', 's', 'sp')} = ${L_BEDS}
        ) med on ${L_TYPE} is not null and ${L_BEDS} is not null
        where ${sql.join(where, sql` and `)}
      )
      select * from base
      where coalesce(lower_by, 0) > 0
         or coalesce(days, 0) >= ${LONG_CAMPAIGN_DAYS}
         or (coalesce(sales, 0) >= ${MEDIAN_MIN_SALES} and asking_from < median)
      order by changed_at desc nulls last, days desc nulls last, listing_id
      limit ${OPPORTUNITY_CANDIDATES + 1}`),
    // The site's median days on the market today, for the long-campaign line (decision 5).
    db.execute(sql`
      select percentile_cont(0.5) within group (order by ${DAYS}) as days
      from listing l where l.status = ${PUBLIC_STATUS} and l.channel = 'sale' and l.published_at is not null and l.agency_id not in ${SUSPENDED_AGENCY_IDS}`),
    // The most sales in one suburb–kind–bedrooms group in the area: what "not enough sales" means here (decision 8).
    db.execute(sql`
      select coalesce(max(n), 0)::int as most from (
        select count(*) as n from listing s join property sp on sp.id = s.property_id
        where ${SOLD_IN_WINDOW}${areaOnly.length ? sql` and ${sql.join(areaOnly, sql` and `)}` : sql``}
        group by lower(sp.suburb), sp.state, lower(${factSql('property_type', 's', 'sp')}), ${factSql('bedrooms', 's', 'sp')}
      ) g`),
  ]);

  const all = rows as unknown as Raw[];
  const truncated = all.length > OPPORTUNITY_CANDIDATES;
  const homes = all.slice(0, OPPORTUNITY_CANDIDATES).map((r) => ({
    listingId: r.listing_id,
    propertyId: r.property_id,
    address: [r.street?.trim(), r.suburb].filter(Boolean).join(', '),
    suburb: r.suburb,
    state: r.state,
    price: priceText(r.price_display, r.price_from, r.price_to),
    bedrooms: num(r.bedrooms),
    bathrooms: num(r.bathrooms),
    propertyType: r.property_type,
    signals: signalsOfRow(r),
  }));

  const counts = Object.fromEntries(SIGNAL_KINDS.map((k) => [k, homes.filter((h) => h.signals.some((s) => s.kind === k)).length])) as Record<SignalKind, number>;
  const most = Number((groups as { most?: number | string } | undefined)?.most ?? 0);
  const emptyWhy: Partial<Record<SignalKind, string>> = {};
  for (const k of SIGNAL_KINDS) if (!counts[k]) emptyWhy[k] = emptyReason(k, area, most);
  const days = num((market as { days?: unknown } | undefined)?.days);

  const chosen = new Set(ask.signals.length ? ask.signals : SIGNAL_KINDS);
  return {
    area,
    homes: homes
      .map((h) => ({ ...h, signals: h.signals.filter((s) => chosen.has(s.kind)) }))
      .filter((h) => h.signals.length)
      .slice(0, MAX_OPPORTUNITIES),
    counts,
    emptyWhy,
    medianDaysOnMarket: days === null ? null : Math.round(days),
    truncated,
  };
}

const STATES = new Set<string>(AU_STATES);

/**
 * The page's link (`?suburbs=…&state=…&max=…&beds=…&type=…&signals=…`) as an ask; null without an area. The page's
 * form sends its signal boxes as repeated `s=`; both are read. Pure.
 */
export function parseOpportunityLink(params: Record<string, string | string[] | undefined>): OpportunityAsk | null {
  const one = (k: string) => (typeof params[k] === 'string' ? (params[k] as string).trim() : '');
  const suburbs = [
    ...new Set(
      one('suburbs')
        .split(',')
        .map((s) => s.trim().replace(/\s+/g, ' ').toLowerCase())
        .filter((s) => s && s.length <= 60 && /^[a-z' .-]+$/.test(s)),
    ),
  ].slice(0, MAX_SUBURBS);
  const state = STATES.has(one('state').toUpperCase()) ? one('state').toUpperCase() : null;
  if (!suburbs.length && !state) return null;
  const max = Number(one('max'));
  const beds = Number(one('beds'));
  const type = propertyTypeSchema.safeParse(one('type').toLowerCase());
  const boxes = Array.isArray(params.s) ? params.s : typeof params.s === 'string' ? [params.s] : [];
  const signals = [...one('signals').split(','), ...boxes].map((s) => s.trim()).filter((s): s is SignalKind => (SIGNAL_KINDS as readonly string[]).includes(s));
  return {
    suburbs,
    state,
    priceTo: Number.isInteger(max) && max > 0 && max <= 100_000_000 ? max : null,
    bedrooms: Number.isInteger(beds) && beds > 0 && beds <= 20 ? beds : null,
    propertyType: type.success ? type.data : null,
    signals: [...new Set(signals)],
  };
}

/** "Match my profile" (decision 7): the area, budget, bedrooms and first kind from the buyer's profile. Pure. */
export function opportunityAskFromProfile(facts: ProfileFacts, signals: SignalKind[] = []): OpportunityAsk | null {
  const suburbs = (facts.suburbs?.value ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, MAX_SUBURBS);
  if (!suburbs.length || facts.channel?.value === 'rent') return null;
  const type = propertyTypeSchema.safeParse((facts.propertyTypes?.value[0] ?? '').toLowerCase());
  return { suburbs, state: null, priceTo: facts.priceTo?.value ?? null, bedrooms: facts.bedrooms?.value ?? null, propertyType: type.success ? type.data : null, signals };
}

/** The ask back as the page's query string. Pure. */
export function opportunityQuery(ask: OpportunityAsk): string {
  const q = new URLSearchParams();
  if (ask.suburbs.length) q.set('suburbs', ask.suburbs.map(title).join(', '));
  if (ask.state) q.set('state', ask.state);
  if (ask.priceTo !== null) q.set('max', String(ask.priceTo));
  if (ask.bedrooms !== null) q.set('beds', String(ask.bedrooms));
  if (ask.propertyType) q.set('type', ask.propertyType);
  if (ask.signals.length) q.set('signals', ask.signals.join(','));
  return q.toString();
}
