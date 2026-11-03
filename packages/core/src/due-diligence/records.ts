import { and, asc, eq, sql } from 'drizzle-orm';
import { listing, listingPriceChange, type Db } from '@repo/db';
import { propertyTimeline, type PublicTimelineEntry } from '../listings/listing-detail';

/**
 * "What our records show" (ADR 0080, C2 decision 3): facts about one address from SQL, each with a reference
 * (R1, R2…) the AI summary and the drafted questions cite. Nothing here is estimated: sale prices are what the
 * agency recorded, days on the market are counted by Postgres (#4), and price changes exist only since
 * migration 0082 began recording them.
 *
 * The history is the public one (ADR 0013): live, under offer and sold campaigns by any agency. Withdrawn
 * campaigns stay out, as they do on the listing's own history.
 */

/** The day the price-change trigger went live (migration 0082). Shown as "since we began recording". */
export const PRICE_CHANGES_RECORDED_SINCE = '2026-11-03';

export type RecordFact = {
  ref: string;
  /** For the left column: a date, or "Now". */
  when: string;
  text: string;
};

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const day = (d: Date) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
const money = (v: string | number | null) => (v === null ? null : AUD.format(Number(v)));

function priceText(display: string | null, from: string | number | null, to: string | number | null): string {
  if (display?.trim()) return display.trim();
  if (from !== null && to !== null) return `${money(from)} – ${money(to)}`;
  return money(from ?? to) ?? 'no price shown';
}

/** Pure: the facts, newest first, from what the three reads returned. Exported for the tests. */
export function recordFacts(input: {
  timeline: readonly PublicTimelineEntry[];
  current: null | { id: string; channel: string; publishedAt: Date | null; daysOnMarket: number | null; priceDisplay: string | null; priceFrom: string | null; priceTo: string | null };
  priceChanges: readonly { changedAt: Date; oldDisplay: string | null; oldFrom: string | null; oldTo: string | null; newDisplay: string | null; newFrom: string | null; newTo: string | null }[];
}): RecordFact[] {
  const facts: Omit<RecordFact, 'ref'>[] = [];
  const { current } = input;
  if (current?.publishedAt) {
    const days = current.daysOnMarket === null ? '' : ` — ${current.daysOnMarket} ${current.daysOnMarket === 1 ? 'day' : 'days'} on the market`;
    facts.push({ when: 'Now', text: `${current.channel === 'rent' ? 'For rent' : 'For sale'} since ${day(current.publishedAt)}${days}. ${priceText(current.priceDisplay, current.priceFrom, current.priceTo)}.` });
    for (const c of [...input.priceChanges].reverse()) {
      facts.push({ when: day(c.changedAt), text: `Price changed from ${priceText(c.oldDisplay, c.oldFrom, c.oldTo)} to ${priceText(c.newDisplay, c.newFrom, c.newTo)}.` });
    }
    if (!input.priceChanges.length) facts.push({ when: 'Price changes', text: `None since we began recording on ${day(new Date(`${PRICE_CHANGES_RECORDED_SINCE}T00:00:00+11:00`))}.` });
  }
  for (const e of input.timeline) {
    if (e.listingId === current?.id) continue;
    if (e.status === 'sold' && e.soldDate) {
      facts.push({ when: day(e.soldDate), text: e.soldPrice === null ? 'Sold — price not disclosed.' : `Sold for ${AUD.format(e.soldPrice)}.` });
    } else if (e.publishedAt) {
      facts.push({ when: day(e.publishedAt), text: `${e.channel === 'rent' ? 'Listed for rent' : 'Listed for sale'} by ${e.agencyName}${e.status === 'under_offer' ? ' — under offer' : ''}.` });
    }
  }
  return facts.map((f, i) => ({ ref: `R${i + 1}`, ...f }));
}

/**
 * The facts for an address, and for the listing being viewed when there is one. Three reads, a fixed count:
 * the public history, the current listing with its days on the market, and that listing's price changes.
 */
export async function dueDiligenceRecords(db: Db, propertyId: string, listingId: string | null): Promise<RecordFact[]> {
  const [timeline, currentRows, priceChanges] = await Promise.all([
    propertyTimeline(db, propertyId),
    listingId
      ? db
          .select({
            id: listing.id,
            channel: listing.channel,
            publishedAt: listing.publishedAt,
            // Counted by Postgres in Sydney's calendar (#4), never in the browser or the model.
            daysOnMarket: sql<number | null>`case when ${listing.publishedAt} is null then null else ((now() at time zone 'Australia/Sydney')::date - (${listing.publishedAt} at time zone 'Australia/Sydney')::date) end`,
            priceDisplay: listing.priceDisplay,
            priceFrom: listing.priceFrom,
            priceTo: listing.priceTo,
          })
          .from(listing)
          .where(and(eq(listing.id, listingId), eq(listing.propertyId, propertyId)))
          .limit(1)
      : Promise.resolve([]),
    listingId
      ? db
          .select({
            changedAt: listingPriceChange.changedAt,
            oldDisplay: listingPriceChange.oldDisplay,
            oldFrom: listingPriceChange.oldFrom,
            oldTo: listingPriceChange.oldTo,
            newDisplay: listingPriceChange.newDisplay,
            newFrom: listingPriceChange.newFrom,
            newTo: listingPriceChange.newTo,
          })
          .from(listingPriceChange)
          .where(eq(listingPriceChange.listingId, listingId))
          .orderBy(asc(listingPriceChange.changedAt), asc(listingPriceChange.id))
      : Promise.resolve([]),
  ]);
  const current = currentRows[0] ? { ...currentRows[0], daysOnMarket: currentRows[0].daysOnMarket === null ? null : Number(currentRows[0].daysOnMarket) } : null;
  return recordFacts({ timeline, current, priceChanges });
}
