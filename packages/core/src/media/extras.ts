import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { listing, media, type Db, type DbOrTx } from '@repo/db';
import { publicListing } from '../listings/search-listings';
import { ROOM_TYPES, type RoomType } from '../renovation/plan';
import { keyBelongsTo } from './storage-key';
import { MediaError, describeObject } from './storage-client';
import { mediaUrl } from './media-url';

/**
 * Immersive Property AI's media (ADR 0080, C9 decisions 2–3; mock docs/mocks/consumer-media-land.html#immersive):
 * floorplans, video and 3D tours, as agents publish them. A floorplan is an image in the listing's storage, like a
 * photo. A video or tour is a LINK on a fixed allowlist, stored as `provider:id` — never a URL, so `storage_key` keeps
 * its rule (no `://`, smoke) and no address we did not build is ever embedded. No video is processed here.
 *
 * The guide knows a floorplan's rooms by NAME (a vision reader in packages/ai, a strict schema of C3's room types) and
 * never a size: a misread dimension would be an invented number (non-negotiable 4).
 */

export { embedUrl, LINK_PROVIDERS, linkKey, MAX_FLOORPLANS, MAX_TOURS, MAX_VIDEOS, parseMediaLink, PROVIDER_NAME, readLinkKey, type LinkProvider, type MediaLink } from './links';
import { embedUrl, linkKey, MAX_FLOORPLANS, MAX_TOURS, MAX_VIDEOS, parseMediaLink, PROVIDER_NAME, readLinkKey, type MediaLink } from './links';

/** Room names a floorplan shows — the reader's whole answer. `.strict()`: a key beyond `rooms` (a size) refuses it. */
export const floorplanRoomsSchema = z.object({ rooms: z.array(z.enum(ROOM_TYPES)).max(30) }).strict();
export type FloorplanRooms = z.infer<typeof floorplanRoomsSchema>;
export type FloorplanReader = (input: { imageUrl: string }) => Promise<unknown>;
export const FLOORPLAN_FEATURE = 'consumer:floorplan_rooms';

/** Each room type once, in ROOM_TYPES order; "other" left out. Pure. */
export function roomNames(answer: FloorplanRooms): RoomType[] {
  const set = new Set(answer.rooms);
  return ROOM_TYPES.filter((r) => r !== 'other' && set.has(r));
}

export const ROOM_LABEL: Record<RoomType, string> = {
  kitchen: 'Kitchen',
  bathroom: 'Bathroom',
  ensuite: 'Ensuite',
  toilet: 'Toilet',
  laundry: 'Laundry',
  bedroom: 'Bedrooms',
  living: 'Living',
  dining: 'Dining',
  study: 'Study',
  garage: 'Garage',
  deck: 'Deck',
  balcony: 'Balcony',
  pool: 'Pool',
  garden: 'Garden',
  front_exterior: 'Front',
  other: 'Other',
};

export type ListingExtras = {
  floorplans: { id: string; url: string; width: number | null; height: number | null; rooms: RoomType[] | null }[];
  videos: (MediaLink & { mediaId: string; embed: string })[];
  tours: (MediaLink & { mediaId: string; embed: string })[];
};

const readRooms = (tags: unknown): RoomType[] | null => {
  const parsed = z.object({ rooms: z.array(z.enum(ROOM_TYPES)) }).passthrough().safeParse(tags);
  return parsed.success ? parsed.data.rooms : null;
};

/** A PUBLIC listing's floorplans, videos and tours, in the agency's order. One read; empty for a listing not public. */
export async function listingExtras(db: DbOrTx, listingId: string): Promise<ListingExtras> {
  const rows = await db
    .select({ id: media.id, kind: media.kind, key: media.storageKey, width: media.width, height: media.height, tags: media.aiTags })
    .from(media)
    .innerJoin(listing, eq(listing.id, media.listingId))
    .where(and(eq(media.listingId, listingId), sql`${media.kind} in ('floorplan', 'video', 'tour')`, publicListing()))
    .orderBy(asc(media.sortOrder), asc(media.createdAt), asc(media.id));
  const out: ListingExtras = { floorplans: [], videos: [], tours: [] };
  for (const r of rows) {
    if (r.kind === 'floorplan') {
      const url = mediaUrl(r.key);
      if (url) out.floorplans.push({ id: r.id, url, width: r.width, height: r.height, rooms: readRooms(r.tags) });
      continue;
    }
    const link = readLinkKey(r.key);
    if (link) (link.kind === 'video' ? out.videos : out.tours).push({ ...link, mediaId: r.id, embed: embedUrl(link) });
  }
  return out;
}

/** The console's list (any status): what the agency has added. One read. */
export async function editableExtras(db: DbOrTx, listingId: string): Promise<{ id: string; kind: string; label: string; url: string | null }[]> {
  const rows = await db
    .select({ id: media.id, kind: media.kind, key: media.storageKey })
    .from(media)
    .where(and(eq(media.listingId, listingId), sql`${media.kind} in ('floorplan', 'video', 'tour')`))
    .orderBy(asc(media.kind), asc(media.sortOrder), asc(media.createdAt));
  return rows.map((r) => {
    if (r.kind === 'floorplan') return { id: r.id, kind: r.kind, label: 'Floorplan', url: mediaUrl(r.key) };
    const l = readLinkKey(r.key);
    return { id: r.id, kind: r.kind, label: l ? `${r.kind === 'tour' ? '3D tour' : 'Video'} · ${PROVIDER_NAME[l.provider]}` : 'A link this version cannot read', url: l ? embedUrl(l) : null };
  });
}

async function countOf(tx: DbOrTx, listingId: string, kind: 'floorplan' | 'video' | 'tour'): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(media).where(and(eq(media.listingId, listingId), eq(media.kind, kind)));
  return Number(r?.n ?? 0);
}

/**
 * Add a video or tour link (the caller checked `listing:edit`, as for photos). Only the allowlist; the same link twice
 * is one row. Returns the media id.
 */
export async function addListingLink(db: Db, listingId: string, raw: string): Promise<{ mediaId: string; kind: 'video' | 'tour' }> {
  const link = parseMediaLink(raw);
  if (!link) throw new MediaError('Use a YouTube or Vimeo video link, or a Matterport 3D tour link.');
  return db.transaction(async (tx) => {
    const key = linkKey(link);
    const [dup] = await tx.select({ id: media.id }).from(media).where(and(eq(media.listingId, listingId), eq(media.storageKey, key))).limit(1);
    if (dup) return { mediaId: dup.id, kind: link.kind };
    const n = await countOf(tx, listingId, link.kind);
    const max = link.kind === 'video' ? MAX_VIDEOS : MAX_TOURS;
    if (n >= max) throw new MediaError(`A listing can carry ${max} ${link.kind === 'video' ? 'videos' : '3D tours'}`);
    const [row] = await tx.insert(media).values({ listingId, kind: link.kind, storageKey: key, sortOrder: n }).returning({ id: media.id });
    return { mediaId: row!.id, kind: link.kind };
  });
}

/**
 * Attach an uploaded floorplan image — the photo rule exactly: the key must belong to this listing and the object must
 * exist (an HTTP call, before the transaction), then the row. Its rooms are read later by the reader.
 */
export async function addListingFloorplan(db: Db, listingId: string, storageKey: string, meta: { width?: number | null; height?: number | null } = {}): Promise<{ mediaId: string }> {
  if (!keyBelongsTo(storageKey, { kind: 'listing', id: listingId })) throw new MediaError('That image does not belong to this listing');
  if (!(await describeObject(storageKey))) throw new MediaError('That image was not uploaded — try again');
  return db.transaction(async (tx) => {
    const n = await countOf(tx, listingId, 'floorplan');
    if (n >= MAX_FLOORPLANS) throw new MediaError(`A listing can carry ${MAX_FLOORPLANS} floorplans`);
    const [row] = await tx.insert(media).values({ listingId, kind: 'floorplan', storageKey, width: meta.width ?? null, height: meta.height ?? null, sortOrder: n }).returning({ id: media.id });
    return { mediaId: row!.id };
  });
}

/**
 * Remove a floorplan, video or tour (never a photo — that has its own cover rule). The row goes first; a floorplan's key
 * comes back for the storage delete after, as photos do.
 */
export async function removeListingExtra(db: DbOrTx, listingId: string, mediaId: string): Promise<{ removed: boolean; storageKey: string | null }> {
  const gone = await db
    .delete(media)
    .where(and(eq(media.id, mediaId), eq(media.listingId, listingId), sql`${media.kind} in ('floorplan', 'video', 'tour')`))
    .returning({ kind: media.kind, key: media.storageKey });
  const row = gone[0];
  return { removed: Boolean(row), storageKey: row?.kind === 'floorplan' ? row.key : null };
}

// ── the rooms reader's batch (on the alerts cron; metered, a few a tick) ──

export const FLOORPLAN_BATCH = 5;

/** Public listings' floorplans not yet read, oldest first. One read. */
export async function unreadFloorplans(db: DbOrTx, limit = FLOORPLAN_BATCH): Promise<{ id: string; url: string }[]> {
  const rows = await db
    .select({ id: media.id, key: media.storageKey })
    .from(media)
    .innerJoin(listing, eq(listing.id, media.listingId))
    .where(and(eq(media.kind, 'floorplan'), isNull(media.aiTags), publicListing()))
    .orderBy(asc(media.createdAt), asc(media.id))
    .limit(limit);
  return rows.flatMap((r) => {
    const url = mediaUrl(r.key);
    return url ? [{ id: r.id, url }] : [];
  });
}

/**
 * Read a batch of floorplans with the reader and keep the room NAMES. An answer that is not exactly room names is
 * stored as "read, nothing kept" so it is not paid for again; the guide then has no rooms for that plan.
 */
export async function readFloorplanBatch(db: Db, reader: FloorplanReader | null, now: Date = new Date()): Promise<{ read: number; kept: number }> {
  if (!reader) return { read: 0, kept: 0 };
  const due = await unreadFloorplans(db);
  let kept = 0;
  for (const f of due) {
    const raw = await reader({ imageUrl: f.url }).catch(() => undefined);
    if (raw === undefined) continue; // the model failed: try again next tick
    const parsed = floorplanRoomsSchema.safeParse(raw);
    const rooms = parsed.success ? roomNames(parsed.data) : null;
    if (rooms) kept += 1;
    await db.update(media).set({ aiTags: rooms ? { rooms, readAt: now.toISOString() } : { rooms: null, refusedAt: now.toISOString() }, updatedAt: sql`now()` }).where(and(eq(media.id, f.id), eq(media.kind, 'floorplan')));
  }
  return { read: due.length, kept };
}

/** What the guide reads for a listing (decision 3): the rooms by name, and where the floorplan is. Pure. */
export function floorplanToolResult(listingId: string, extras: ListingExtras): { found: boolean; rooms: string[]; floorplans: number; videos: number; tours: number; page: string; rules: string } {
  const rooms = [...new Set(extras.floorplans.flatMap((f) => f.rooms ?? []))];
  return {
    found: extras.floorplans.length + extras.videos.length + extras.tours.length > 0,
    rooms: ROOM_TYPES.filter((r) => rooms.includes(r)).map((r) => ROOM_LABEL[r]),
    floorplans: extras.floorplans.length,
    videos: extras.videos.length,
    tours: extras.tours.length,
    page: `/listing/${listingId}#floorplan`,
    rules: 'Name the rooms only. Never give a size, a dimension or an area, and never say whether furniture will fit: say the sizes are on the floorplan itself, link the page, and suggest asking the agent. Room names were read from the floorplan by AI; bedroom and bathroom counts are the listing’s own, from its facts.',
  };
}
