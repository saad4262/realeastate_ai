import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import { PUBLIC_STATUS, type PublicListingSummary, type PublicSearchQuery } from '../listings/search-listings';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';
import { priceText } from '../due-diligence/records';
import { findOpportunities, signalLine } from '../buyer-opportunities';
import { suburbProfile } from '../research/suburb';
import type { SavedSearchQuery } from '../listings/search-url';
import { NEWS_SECTIONS, TASK_SECTION_TEXT, type TaskSection } from './sections';

/**
 * A task's report (ADR 0080, C8 decision 6): each chosen section read from SQL, in the order chosen. Every figure is
 * the database's and is formatted here; nothing in a report is model-written. "Since" is the previous run's start, or
 * the last 7 days on a first run. One read per section (the search is the runner's own uncached reader).
 */

export type ReportRow = { text: string; detail?: string; href?: string };
export type ReportSection = { key: TaskSection; title: string; rows: ReportRow[]; note?: string };
export type TaskReport = { sections: ReportSection[]; hasNews: boolean; newListingIds: string[] };

export type TaskReportDeps = {
  /** The runner's uncached public search, with the centre already resolved. */
  search: (query: PublicSearchQuery) => Promise<PublicListingSummary[]>;
};

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const FIRST_RUN_DAYS = 7;
const MAX_ROWS = 10;
const STREET = sql`nullif(trim(concat(case when p.unit is not null then p.unit || '/' end, concat_ws(' ', p.street_number, p.street))), '')`;

const facts = (beds: number | null, type: string | null) => [beds !== null ? `${beds} bed` : null, type].filter(Boolean).join(' ');

export async function buildTaskReport(
  db: DbOrTx,
  deps: TaskReportDeps,
  input: { userId: string; query: SavedSearchQuery; runtimeQuery: PublicSearchQuery; sections: TaskSection[]; since: Date | null; previousListingIds: string[]; now: Date; timeZone: string },
): Promise<TaskReport> {
  const since = input.since ?? new Date(input.now.getTime() - FIRST_RUN_DAYS * 86_400_000);
  const q = input.query;
  const area = { suburbs: q.suburb ? [q.suburb.toLowerCase()] : [], state: q.state ?? null };
  const day = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: input.timeZone });
  const when = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: input.timeZone });
  let newListingIds: string[] = [];

  const read = async (key: TaskSection): Promise<ReportSection> => {
    const title = TASK_SECTION_TEXT[key].title;
    switch (key) {
      case 'new_homes': {
        const found = await deps.search(input.runtimeQuery);
        const before = new Set(input.previousListingIds);
        const fresh = found.filter((l) => !before.has(l.id));
        newListingIds = found.map((l) => l.id);
        return { key, title, rows: fresh.slice(0, MAX_ROWS).map((l) => ({ text: `${l.address}, ${l.suburb}`, detail: [facts(l.bedrooms, l.propertyType), l.priceDisplay ?? priceText(null, l.priceFrom, l.priceTo)].filter(Boolean).join(' · '), href: `/listing/${l.id}` })) };
      }
      case 'sold': {
        const rows = (await db.execute(sql`
          select l.id, ${STREET} as street, p.suburb, l.sold_price, l.sold_date, coalesce(l.bedrooms, p.bedrooms) as bedrooms
          from listing l join property p on p.id = l.property_id
          where l.status = 'sold' and l.sold_date > ${since.toISOString()}::timestamptz and lower(p.suburb) = lower(${q.suburb ?? ''})
            ${q.state ? sql`and p.state = ${q.state}` : sql``} and l.agency_id not in ${SUSPENDED_AGENCY_IDS}
          order by l.sold_date desc, l.id limit ${MAX_ROWS}`)) as unknown as { id: string; street: string | null; suburb: string; sold_price: string | null; sold_date: Date | string; bedrooms: number | null }[];
        return { key, title, rows: rows.map((r) => ({ text: [r.street, r.suburb].filter(Boolean).join(', '), detail: `${r.sold_price === null ? 'Sold, price not disclosed' : `Sold ${AUD.format(Number(r.sold_price))}`} · ${day.format(new Date(r.sold_date))}` })) };
      }
      case 'price_reduced':
      case 'long_campaign': {
        const o = await findOpportunities(db, { ...area, priceTo: q.priceTo ?? null, bedrooms: q.bedrooms ?? null, propertyType: q.propertyType ?? null, signals: [key] });
        const rows = o.homes.flatMap((h) =>
          h.signals
            // A reduction is news only once: since the last report. A long campaign is a standing fact.
            .filter((s) => s.kind !== 'price_reduced' || s.on > since)
            .map((s) => ({ text: h.address, detail: signalLine(s), href: `/listing/${h.listingId}` })),
        );
        return { key, title, rows: rows.slice(0, MAX_ROWS), ...(rows.length ? {} : o.emptyWhy[key] ? { note: o.emptyWhy[key] } : {}) };
      }
      case 'suburb_figures': {
        const p = q.suburb && q.state ? await suburbProfile(db, { state: q.state, suburb: q.suburb }) : null;
        if (!p) return { key, title, rows: [], note: 'Needs a suburb and its state.' };
        return {
          key,
          title: `${p.suburb} on this site`,
          rows: [
            { text: 'For sale now', detail: String(p.forSale) },
            { text: 'Median sold price, 12 months', detail: p.medianSold ? `${AUD.format(p.medianSold.value)} (${p.medianSold.sales} sales)` : `Not enough sales (${p.salesInWindow})` },
            ...(p.medianDays ? [{ text: 'Median days on the market', detail: `${p.medianDays.value} days` }] : []),
          ],
        };
      }
      case 'open_homes': {
        // The search's homes (when it has an area) and the buyer's shortlist: public, open times only, the next 7 days.
        const searchIds = q.suburb || q.state ? (await deps.search(input.runtimeQuery)).map((l) => l.id) : [];
        const rows = (await db.execute(sql`
          select i.starts_at, i.ends_at, l.id, ${STREET} as street, p.suburb
          from inspection i join listing l on l.id = i.listing_id join property p on p.id = l.property_id
          where i.kind = 'open' and i.starts_at > ${input.now.toISOString()}::timestamptz and i.starts_at < ${new Date(input.now.getTime() + 7 * 86_400_000).toISOString()}::timestamptz
            and l.status = ${PUBLIC_STATUS} and l.agency_id not in ${SUSPENDED_AGENCY_IDS}
            and (l.id in (select s.listing_id from shortlist s where s.user_id = ${input.userId})${searchIds.length ? sql` or l.id in ${searchIds}` : sql``})
          order by i.starts_at, l.id limit ${MAX_ROWS}`)) as unknown as { starts_at: Date | string; ends_at: Date | string; id: string; street: string | null; suburb: string }[];
        return { key, title, rows: rows.map((r) => ({ text: [r.street, r.suburb].filter(Boolean).join(', '), detail: when.format(new Date(r.starts_at)), href: `/listing/${r.id}` })) };
      }
      case 'watched': {
        const rows = (await db.execute(sql`
          select e.text, e.happened_at, p.id as property_id, ${STREET} as street, p.suburb
          from property_watch_event e join property p on p.id = e.property_id
          where e.user_id = ${input.userId} and e.happened_at > ${since.toISOString()}::timestamptz
          order by e.happened_at desc, e.id limit ${MAX_ROWS}`)) as unknown as { text: string; happened_at: Date | string; property_id: string; street: string | null; suburb: string }[];
        return { key, title, rows: rows.map((r) => ({ text: [r.street, r.suburb].filter(Boolean).join(', '), detail: `${day.format(new Date(r.happened_at))} — ${r.text}`, href: `/property/${r.property_id}` })), ...(rows.length ? {} : { note: 'Nothing changed at the addresses you watch (Property Monitor must be on).' }) };
      }
    }
  };

  const sections: ReportSection[] = [];
  for (const key of input.sections) sections.push(await read(key));
  const news = sections.filter((s) => NEWS_SECTIONS.has(s.key));
  // A report of standing facts only (figures, long campaigns) is always worth sending: there is no "new" to wait for.
  const hasNews = news.length ? news.some((s) => s.rows.length) : sections.some((s) => s.rows.length);
  return { sections: sections.map((s) => ({ ...s, title: `${s.title}${NEWS_SECTIONS.has(s.key) ? ` · ${s.rows.length}` : ''}` })), hasNews, newListingIds };
}
