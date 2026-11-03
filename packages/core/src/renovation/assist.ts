import { and, eq } from 'drizzle-orm';
import { listing, property, type Db } from '@repo/db';
import { AU_DUTY_STATES, type DutyState } from '../affordability/duty-rates';
import { publicListing } from '../listings/search-listings';
import { listingPhotos } from '../media/listing-media';
import { mediaUrl } from '../media/media-url';
import { renovationCategory, TRADE_LABELS, type RenovationCategoryKey } from './categories';
import { permitNotesFor, type PermitNote } from './permits';
import { checkPlan, photoRoomsSchema, roomsFromPhotos, type PhotoRooms, type PlanDraft, type RoomType } from './plan';

/**
 * Renovation AI end to end, model side (ADR 0080, C3). Core decides what the model is given and keeps only what
 * the rules allow: the plan through `checkPlan` (known kinds of work only, no money), the photos through the
 * strict room schema. Everything shown beside a kind of work — cost drivers, trades, permit notes — comes from
 * categories.ts and permits.ts, never from the model. No figure is produced anywhere (decision 1).
 */

export const RENOVATION_FEATURE = 'consumer:renovation';
export const RENOVATION_ROOMS_FEATURE = 'consumer:renovation_rooms';
/** Photos read per listing: enough to name the rooms, few enough to keep a vision call cheap. */
export const MAX_ROOM_PHOTOS = 8;
export const REQUEST_MIN = 3;
export const REQUEST_MAX = 1000;

export type RenovationPlanner = (input: { request: string; rooms: readonly RoomType[] }) => Promise<PlanDraft>;
export type RoomReader = (input: { photoUrls: readonly string[] }) => Promise<PhotoRooms>;

export class RenovationError extends Error {
  constructor(
    public readonly code: 'invalid' | 'not_found' | 'unavailable' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'RenovationError';
  }
}

/** One kind of work as the page shows it: the model's line in the buyer's terms, the rest ours. */
export type PlanCard = {
  category: RenovationCategoryKey;
  name: string;
  note: string;
  costDrivers: readonly string[];
  trades: string[];
};

export type RenovationPlan = { state: DutyState | null; cards: PlanCard[]; permits: PermitNote[] };

/** The cards and the permit notes for kinds of work already chosen — by the model's plan or by the guide. Pure. */
export function planCards(items: readonly { category: RenovationCategoryKey; note: string }[], state: DutyState | null): RenovationPlan {
  const cards = items.map((i) => {
    const c = renovationCategory(i.category);
    return { category: c.key, name: c.name, note: i.note, costDrivers: c.costDrivers, trades: c.trades.map((t) => TRADE_LABELS[t]) };
  });
  return { state, cards, permits: state ? permitNotesFor(state, cards.map((c) => c.category)) : [] };
}

export function asState(value: unknown): DutyState | null {
  return typeof value === 'string' && (AU_DUTY_STATES as readonly string[]).includes(value) ? (value as DutyState) : null;
}

/** The buyer's words → a checked plan. The state, when known, brings its permit notes. */
export async function buildRenovationPlan(planner: RenovationPlanner | null, input: { request: string; state: DutyState | null; rooms?: readonly RoomType[] }): Promise<RenovationPlan> {
  const request = input.request.replace(/\s+/g, ' ').trim();
  if (request.length < REQUEST_MIN || request.length > REQUEST_MAX) throw new RenovationError('invalid', `Tell us what you would change, in up to ${REQUEST_MAX} characters.`);
  if (!planner) throw new RenovationError('unavailable', 'The AI is not available right now. The kinds of work below still apply.');
  let draft: PlanDraft;
  try {
    draft = await planner({ request, rooms: input.rooms ?? [] });
  } catch {
    throw new RenovationError('failed', 'The AI could not answer just now. Try again in a moment.');
  }
  return planCards(checkPlan(draft), input.state);
}

/**
 * A public listing the page may start from (ARCHITECTURE § 9: the browser names an id, the server decides):
 * its address, state and photo URLs. Null for anything the public cannot see.
 */
export async function renovationListing(db: Db, listingId: string): Promise<null | { listingId: string; address: string; state: DutyState | null; photoUrls: string[] }> {
  const [row] = await db
    .select({ street: property.street, number: property.streetNumber, suburb: property.suburb, state: property.state })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(and(eq(listing.id, listingId), publicListing()))
    .limit(1);
  if (!row) return null;
  const photos = await listingPhotos(db, listingId);
  return {
    listingId,
    address: [[row.number, row.street].filter(Boolean).join(' '), row.suburb].filter(Boolean).join(', '),
    state: asState(row.state),
    photoUrls: photos.slice(0, MAX_ROOM_PHOTOS).map((p) => mediaUrl(p.storageKey)).filter((u): u is string => Boolean(u)),
  };
}

/** Which rooms the listing's photos show — rooms only (decision 3); counted in code. */
export async function listingRooms(db: Db, reader: RoomReader | null, listingId: string): Promise<{ room: RoomType; photos: number }[]> {
  if (!reader) throw new RenovationError('unavailable', 'The AI is not available right now.');
  const found = await renovationListing(db, listingId);
  if (!found) throw new RenovationError('not_found', 'That listing is not available.');
  if (!found.photoUrls.length) return [];
  let raw: unknown;
  try {
    raw = await reader({ photoUrls: found.photoUrls });
  } catch {
    throw new RenovationError('failed', 'The AI could not read the photos just now.');
  }
  const parsed = photoRoomsSchema.safeParse(raw);
  // Anything beyond a room type — a word about condition — refuses the whole answer (decision 3).
  if (!parsed.success) throw new RenovationError('failed', 'The AI could not read the photos just now.');
  return roomsFromPhotos(parsed.data, found.photoUrls.length);
}
