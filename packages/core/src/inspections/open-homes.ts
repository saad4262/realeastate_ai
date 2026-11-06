import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { inspection, listing, property, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { stateTimeZone } from './plan';
import {
  IMPORTED_AUCTION_MINUTES,
  MAX_AHEAD_DAYS,
  MAX_UPCOMING_OPEN_HOMES,
  checkOpenHomeSlots,
  openHomeDay,
  openHomeInputSchema,
  openHomeNextWeek,
  openHomeSlots,
  openHomeTime,
  statePlace,
  type ExistingOpenHome,
  type OpenHomeInput,
  type OpenHomeKind,
  type OpenHomeSlot,
} from './open-home-rules';

/**
 * A listing's open homes, entered by whoever may edit it (ADR 0081). Each write is one transaction with the listing's row locked,
 * so two people adding at once cannot pass the limit or the overlap check together.
 */

export class OpenHomeError extends Error {
  readonly confirm: boolean;
  constructor(message: string, confirm = false) {
    super(message);
    this.name = 'OpenHomeError';
    this.confirm = confirm;
  }
}

const NOT_FOUND = 'That listing could not be found';
const PAST_LIMIT = 20;

type Target = { status: string; state: string; timeZone: string; place: string };

/** Another agency's listing and one this person may not edit read the same, so neither confirms the id exists. */
async function editable(db: DbOrTx, actor: Actor, listingId: string, lock: boolean): Promise<Target> {
  const query = db
    .select({ agencyId: listing.agencyId, status: listing.status, state: property.state })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(eq(listing.id, listingId))
    .limit(1);
  const [row] = lock ? await query.for('update', { of: listing }) : await query;
  if (!row || !can(actor, 'listing:edit', { type: 'listing', id: listingId, agencyId: row.agencyId })) throw new OpenHomeError(NOT_FOUND);
  return { status: row.status, state: row.state, timeZone: stateTimeZone(row.state), place: statePlace(row.state) };
}

async function upcoming(db: DbOrTx, listingId: string, now: Date): Promise<ExistingOpenHome[]> {
  const rows = await db
    .select({ id: inspection.id, startsAt: inspection.startsAt, endsAt: inspection.endsAt, kind: inspection.kind })
    .from(inspection)
    .where(and(eq(inspection.listingId, listingId), gte(inspection.endsAt, now)))
    .orderBy(asc(inspection.startsAt));
  return rows as ExistingOpenHome[];
}

/** `listing.auction_date` follows the next upcoming auction (ADR 0081: one truth). */
async function syncAuctionDate(db: DbOrTx, listingId: string, now: Date): Promise<void> {
  await db
    .update(listing)
    .set({ auctionDate: sql`(select min(${inspection.startsAt}) from ${inspection} where ${inspection.listingId} = ${listingId} and ${inspection.kind} = 'auction' and ${inspection.endsAt} >= ${now.toISOString()}::timestamptz)` })
    .where(eq(listing.id, listingId));
}

export type OpenHomesView = {
  status: string;
  timeZone: string;
  place: string;
  upcoming: ExistingOpenHome[];
  past: ExistingOpenHome[];
  pastCount: number;
};

/** The tab: three statements (the target, what is ahead, the latest of what has passed with their count). */
export async function openHomesForListing(db: DbOrTx, actor: Actor, listingId: string, now: Date = new Date()): Promise<OpenHomesView> {
  const target = await editable(db, actor, listingId, false);
  const [ahead, pastRows] = await Promise.all([
    upcoming(db, listingId, now),
    db
      .select({ id: inspection.id, startsAt: inspection.startsAt, endsAt: inspection.endsAt, kind: inspection.kind, total: sql<number>`count(*) over ()::int` })
      .from(inspection)
      .where(and(eq(inspection.listingId, listingId), lt(inspection.endsAt, now)))
      .orderBy(desc(inspection.startsAt))
      .limit(PAST_LIMIT),
  ]);
  return {
    status: target.status,
    timeZone: target.timeZone,
    place: target.place,
    upcoming: ahead,
    past: pastRows.map(({ total: _total, ...r }) => r as ExistingOpenHome),
    pastCount: Number(pastRows[0]?.total ?? 0),
  };
}

/** The tab's count. One statement. */
export async function upcomingOpenHomeCount(db: DbOrTx, listingId: string, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inspection)
    .where(and(eq(inspection.listingId, listingId), gte(inspection.endsAt, now)));
  return Number(row?.n ?? 0);
}

function parseInput(raw: OpenHomeInput) {
  const parsed = openHomeInputSchema.safeParse(raw);
  if (!parsed.success) throw new OpenHomeError(parsed.error.issues[0]?.message ?? 'That time could not be read.');
  return parsed.data;
}

function refuseUnlessOk(check: ReturnType<typeof checkOpenHomeSlots>): void {
  if (!check.ok) throw new OpenHomeError(check.message, check.confirm === true);
}

export async function addOpenHomes(db: DbOrTx, actor: Actor, listingId: string, raw: OpenHomeInput, deps: { now?: Date } = {}): Promise<{ added: number }> {
  const input = parseInput(raw);
  const now = deps.now ?? new Date();
  return db.transaction(async (tx) => {
    const target = await editable(tx, actor, listingId, true);
    const slots = openHomeSlots(input, target.timeZone);
    if (!slots) throw new OpenHomeError('That time could not be read.');
    refuseUnlessOk(checkOpenHomeSlots(slots, { kind: input.kind, existing: await upcoming(tx, listingId, now), now, timeZone: target.timeZone, place: target.place, confirmedHours: input.confirmedHours }));
    await tx.insert(inspection).values(slots.map((s) => ({ listingId, startsAt: s.startsAt, endsAt: s.endsAt, kind: input.kind, createdBy: actor.userId })));
    if (input.kind === 'auction') await syncAuctionDate(tx, listingId, now);
    return { added: slots.length };
  });
}

/** Changes one row in place: its id stays, so a buyer's plan link keeps following it. */
export async function updateOpenHome(db: DbOrTx, actor: Actor, listingId: string, id: string, raw: OpenHomeInput, deps: { now?: Date } = {}): Promise<void> {
  const input = parseInput({ ...raw, weeks: 1 });
  const now = deps.now ?? new Date();
  await db.transaction(async (tx) => {
    const target = await editable(tx, actor, listingId, true);
    const [row] = await tx.select({ kind: inspection.kind }).from(inspection).where(and(eq(inspection.id, id), eq(inspection.listingId, listingId))).limit(1);
    if (!row) throw new OpenHomeError('That time is no longer on this listing.');
    const slots = openHomeSlots(input, target.timeZone);
    if (!slots) throw new OpenHomeError('That time could not be read.');
    const existing = (await upcoming(tx, listingId, now)).filter((e) => e.id !== id);
    refuseUnlessOk(checkOpenHomeSlots(slots, { kind: input.kind, existing, now, timeZone: target.timeZone, place: target.place, confirmedHours: input.confirmedHours }));
    await tx
      .update(inspection)
      .set({ startsAt: slots[0]!.startsAt, endsAt: slots[0]!.endsAt, kind: input.kind, updatedAt: sql`now()` })
      .where(and(eq(inspection.id, id), eq(inspection.listingId, listingId)));
    if (input.kind === 'auction' || row.kind === 'auction') await syncAuctionDate(tx, listingId, now);
  });
}

export async function removeOpenHome(db: DbOrTx, actor: Actor, listingId: string, id: string, deps: { now?: Date } = {}): Promise<void> {
  const now = deps.now ?? new Date();
  await db.transaction(async (tx) => {
    await editable(tx, actor, listingId, true);
    const [row] = await tx.delete(inspection).where(and(eq(inspection.id, id), eq(inspection.listingId, listingId))).returning({ kind: inspection.kind });
    if (!row) throw new OpenHomeError('That time is no longer on this listing.');
    if (row.kind === 'auction') await syncAuctionDate(tx, listingId, now);
  });
}

/** The row's "Next week": the same wall-clock time 7 days on. Its hours were already accepted, so that question is not asked again. */
export async function copyOpenHomeNextWeek(db: DbOrTx, actor: Actor, listingId: string, id: string, deps: { now?: Date } = {}): Promise<void> {
  const now = deps.now ?? new Date();
  await db.transaction(async (tx) => {
    const target = await editable(tx, actor, listingId, true);
    const [row] = await tx
      .select({ startsAt: inspection.startsAt, endsAt: inspection.endsAt, kind: inspection.kind })
      .from(inspection)
      .where(and(eq(inspection.id, id), eq(inspection.listingId, listingId)))
      .limit(1);
    if (!row) throw new OpenHomeError('That time is no longer on this listing.');
    if (row.kind === 'auction') throw new OpenHomeError('An auction happens once, so it cannot repeat.');
    const next = openHomeNextWeek(row, target.timeZone);
    const slots = openHomeSlots(next, target.timeZone);
    if (!slots) throw new OpenHomeError('That time could not be read.');
    refuseUnlessOk(checkOpenHomeSlots(slots, { kind: row.kind as OpenHomeKind, existing: await upcoming(tx, listingId, now), now, timeZone: target.timeZone, place: target.place, confirmedHours: true }));
    await tx.insert(inspection).values({ listingId, startsAt: slots[0]!.startsAt, endsAt: slots[0]!.endsAt, kind: row.kind, createdBy: actor.userId });
  });
}

/**
 * What a row of the import adds, after the import has checked who is importing. It only ever adds: a time that has passed, is too far
 * ahead, overlaps or is over the limit becomes a warning. An auction date in the file becomes the auction's row when there is none yet.
 */
export async function addImportedOpenHomes(
  db: DbOrTx,
  listingId: string,
  file: { slots: readonly { startsAt: string; endsAt: string }[]; auctionAt: string | null; state: string; userId: string },
  now: Date = new Date(),
): Promise<string[]> {
  if (!file.slots.length && !file.auctionAt) return [];
  const timeZone = stateTimeZone(file.state);
  const warnings: string[] = [];
  const latest = now.getTime() + MAX_AHEAD_DAYS * 86_400_000;
  await db.transaction(async (tx) => {
    await tx.select({ id: listing.id }).from(listing).where(eq(listing.id, listingId)).limit(1).for('update');
    const existing = await upcoming(tx, listingId, now);
    const hadAuction = existing.some((e) => e.kind === 'auction');
    const wanted: (OpenHomeSlot & { kind: OpenHomeKind })[] = file.slots.map((s) => ({ startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt), kind: 'open' as const }));
    if (file.auctionAt && new Date(file.auctionAt) > now) {
      const startsAt = new Date(file.auctionAt);
      if (hadAuction) warnings.push(`This listing already has an auction on ${openHomeDay(existing.find((e) => e.kind === 'auction')!.startsAt, timeZone)}, so it was not changed`);
      else wanted.push({ startsAt, endsAt: new Date(startsAt.getTime() + IMPORTED_AUCTION_MINUTES * 60_000), kind: 'auction' });
    }
    for (const s of wanted) {
      const name = `${openHomeDay(s.startsAt, timeZone)} ${openHomeTime(s.startsAt, timeZone)}`;
      if (s.startsAt <= now) warnings.push(`${name} has passed, so it was not added`);
      else if (s.startsAt.getTime() > latest) warnings.push(`${name} is over 6 months away, so it was not added`);
      else if (existing.length >= MAX_UPCOMING_OPEN_HOMES) warnings.push(`${name} was not added: a listing can have ${MAX_UPCOMING_OPEN_HOMES} upcoming times`);
      else if (existing.some((e) => s.startsAt < e.endsAt && e.startsAt < s.endsAt)) {
        // The file's own time, already on the listing, is not news on a re-import.
        if (!existing.some((e) => e.startsAt.getTime() === s.startsAt.getTime())) warnings.push(`${name} overlaps another time on this listing, so it was not added`);
      } else {
        const [made] = await tx.insert(inspection).values({ listingId, startsAt: s.startsAt, endsAt: s.endsAt, kind: s.kind, createdBy: file.userId }).returning({ id: inspection.id });
        existing.push({ ...s, id: made!.id });
      }
    }
    // Only where this listing has an auction row: otherwise the date the import just wrote stands.
    if (existing.some((e) => e.kind === 'auction')) await syncAuctionDate(tx, listingId, now);
  });
  return warnings;
}
