import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { listing, property, propertyWatch, propertyWatchEvent, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { publicListing } from '../listings/search-listings';
import { HISTORIC_STATUSES } from '../listings/listing-detail';
import { consumerSkillBlocks, consumerSkillOffMessage } from '../consumer-skills';
import { priceText } from '../due-diligence/records';
import { standingOf, type CurrentCampaign, type WatchStanding } from './detect';

/**
 * Property Monitor (ADR 0080, C4 decision 2): a signed-in buyer follows an ADDRESS — listed, price change, under
 * offer, sold, "no longer advertised". Off until the buyer switches it on (it emails by itself). The buyer's own:
 * `property_watch:read/manage` are the owner's only; no agency sees who watches what (decision 7).
 */

export const MAX_WATCHES = 50;
export const DEFAULT_TIME_ZONE = 'Australia/Sydney';

export class WatchError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'skill_off' | 'not_found' | 'limit',
    message: string,
  ) {
    super(message);
    this.name = 'WatchError';
  }
}

function require(actor: Actor, action: 'property_watch:read' | 'property_watch:manage') {
  if (!can(actor, action, { type: 'property_watch', ownerId: actor.userId })) throw new WatchError('forbidden', 'Sign in to watch an address.');
}

/** An IANA zone the runtime knows, or Sydney. Never trusted for anything but the hour the email goes. */
export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || tz.length > 64) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * The latest campaign at each address, in one statement: the newest listing that has ever been published there,
 * by any agency. Drafts never count (they were never advertised).
 */
export async function currentCampaigns(db: DbOrTx, propertyIds: readonly string[]): Promise<Map<string, CurrentCampaign>> {
  if (!propertyIds.length) return new Map();
  const ids = [...new Set(propertyIds)];
  // No alias on `listing`: publicListing() names the table itself.
  const rows = await db.execute<{ property_id: string; id: string; status: string; channel: string; is_public: boolean; price_display: string | null; price_from: string | null; price_to: string | null; rent_pw: string | null; sold_price: string | null }>(sql`
    select distinct on (listing.property_id) listing.property_id, listing.id, listing.status::text as status, listing.channel::text as channel,
           ${publicListing()} as is_public, listing.price_display, listing.price_from, listing.price_to, listing.rent_pw, listing.sold_price
    from listing
    where listing.property_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      and listing.published_at is not null
    order by listing.property_id, listing.published_at desc, listing.id desc`);
  return new Map(
    rows.map((r) => [
      r.property_id,
      {
        listingId: r.id,
        status: r.status,
        channel: r.channel,
        isPublic: Boolean(r.is_public),
        price: r.channel === 'rent' && r.rent_pw ? `${new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(Number(r.rent_pw))} per week` : priceText(r.price_display, r.price_from, r.price_to),
        soldPrice: r.sold_price === null ? null : Number(r.sold_price),
      },
    ]),
  );
}

/** Which property a request may watch: a public listing's address, or an address with public history (the /property page's rule). */
async function watchableProperty(db: DbOrTx, ask: { listingId: string } | { propertyId: string }): Promise<string | null> {
  if ('listingId' in ask) {
    const [row] = await db.select({ propertyId: listing.propertyId }).from(listing).where(and(eq(listing.id, ask.listingId), publicListing())).limit(1);
    return row?.propertyId ?? null;
  }
  const [row] = await db
    .select({ id: listing.propertyId })
    .from(listing)
    .where(and(eq(listing.propertyId, ask.propertyId), inArray(listing.status, [...HISTORIC_STATUSES])))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Start watching. The state now is recorded as already seen, so watching never reports what was true before.
 * Watching twice changes nothing. Property Monitor must be on: it acts by itself (ADR 0080).
 */
export async function watchProperty(db: DbOrTx, actor: Actor, ask: { listingId: string } | { propertyId: string }, timeZone?: string): Promise<{ propertyId: string }> {
  require(actor, 'property_watch:manage');
  const block = (await consumerSkillBlocks(db, actor)).get('property_monitor');
  if (block) throw new WatchError('skill_off', consumerSkillOffMessage('property_monitor', block));
  const propertyId = await watchableProperty(db, ask);
  if (!propertyId) throw new WatchError('not_found', 'That address is not available.');
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(propertyWatch).where(eq(propertyWatch.userId, actor.userId));
  if (Number(n) >= MAX_WATCHES) throw new WatchError('limit', `You can watch up to ${MAX_WATCHES} addresses. Stop watching one first.`);
  const current = (await currentCampaigns(db, [propertyId])).get(propertyId) ?? null;
  await db
    .insert(propertyWatch)
    .values({ userId: actor.userId, propertyId, timeZone: safeTimeZone(timeZone), seenListingId: current?.listingId ?? null, seenStatus: standingOf(current) })
    .onConflictDoNothing();
  return { propertyId };
}

/** Stop watching — always allowed, switch or not: a buyer can always stop something. Its history goes with it. */
export async function unwatchProperty(db: DbOrTx, actor: Actor, propertyId: string): Promise<void> {
  require(actor, 'property_watch:manage');
  await db.delete(propertyWatchEvent).where(and(eq(propertyWatchEvent.userId, actor.userId), eq(propertyWatchEvent.propertyId, propertyId)));
  await db.delete(propertyWatch).where(and(eq(propertyWatch.userId, actor.userId), eq(propertyWatch.propertyId, propertyId)));
}

export async function isWatching(db: DbOrTx, actor: Actor, propertyId: string): Promise<boolean> {
  require(actor, 'property_watch:read');
  const [row] = await db.select({ id: propertyWatch.propertyId }).from(propertyWatch).where(and(eq(propertyWatch.userId, actor.userId), eq(propertyWatch.propertyId, propertyId))).limit(1);
  return Boolean(row);
}

export type WatchView = {
  propertyId: string;
  address: string;
  standing: WatchStanding;
  /** The current campaign's page, when it is public. */
  listingId: string | null;
  since: Date;
  events: { kind: string; text: string; happenedAt: Date }[];
};

/** The Watching page: every watched address with its current standing and its history, newest first. Three reads. */
export async function listWatches(db: DbOrTx, actor: Actor): Promise<WatchView[]> {
  require(actor, 'property_watch:read');
  const watches = await db
    .select({ propertyId: propertyWatch.propertyId, since: propertyWatch.createdAt, street: sql<string>`concat_ws(' ', ${property.streetNumber}, ${property.street})`, suburb: property.suburb, state: property.state })
    .from(propertyWatch)
    .innerJoin(property, eq(property.id, propertyWatch.propertyId))
    .where(eq(propertyWatch.userId, actor.userId))
    .orderBy(desc(propertyWatch.createdAt), desc(propertyWatch.propertyId));
  if (!watches.length) return [];
  const [current, events] = await Promise.all([
    currentCampaigns(db, watches.map((w) => w.propertyId)),
    db
      .select({ propertyId: propertyWatchEvent.propertyId, kind: propertyWatchEvent.kind, text: propertyWatchEvent.text, happenedAt: propertyWatchEvent.happenedAt })
      .from(propertyWatchEvent)
      .where(eq(propertyWatchEvent.userId, actor.userId))
      .orderBy(desc(propertyWatchEvent.happenedAt), desc(propertyWatchEvent.id))
      .limit(500),
  ]);
  return watches.map((w) => {
    const c = current.get(w.propertyId) ?? null;
    return {
      propertyId: w.propertyId,
      address: [w.street?.trim(), `${w.suburb} ${w.state}`].filter(Boolean).join(', '),
      standing: standingOf(c),
      listingId: c && c.isPublic ? c.listingId : null,
      since: w.since,
      events: events.filter((e) => e.propertyId === w.propertyId).map((e) => ({ kind: e.kind, text: e.text, happenedAt: e.happenedAt })),
    };
  });
}
