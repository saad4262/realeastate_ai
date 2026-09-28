import { and, asc, eq, sql } from 'drizzle-orm';
import { agentProfile, listing, media, type Db, type DbOrTx } from '@repo/db';
import { MAX_LISTING_PHOTOS, keyBelongsTo } from './storage-key';
import { MediaError, deleteObject, describeObject } from './storage-client';

/**
 * Listing photos: the rows, not the files.
 *
 * `storage-client.ts` talks to the bucket; this talks to the database. They are
 * separate because the ordering between them is the whole correctness story:
 *
 *   upload → verify the object exists → write the row
 *   delete the row → then delete the object
 *
 * Both orders fail safe. A file with no row is invisible and costs storage; a
 * row with no file is a broken image on a live property ad. Only one of those
 * is worth avoiding, and it decides which way round every operation goes.
 *
 * Network calls happen BEFORE the transaction opens, never inside one — the
 * standing rule in CLAUDE.md, and it matters more here than anywhere else in
 * the codebase, because a storage HEAD to another region inside an open
 * transaction holds a row lock for the length of an internet round trip.
 */

export type ListingPhoto = {
  id: string;
  storageKey: string;
  isMain: boolean;
  sortOrder: number;
  caption: string | null;
  width: number | null;
  height: number | null;
};

/** Every photo on a listing, in the order the agency arranged them. */
export async function listingPhotos(db: Db, listingId: string): Promise<ListingPhoto[]> {
  const rows = await db
    .select({
      id: media.id,
      storageKey: media.storageKey,
      isMain: media.isMain,
      sortOrder: media.sortOrder,
      caption: media.caption,
      width: media.width,
      height: media.height,
    })
    .from(media)
    .where(and(eq(media.listingId, listingId), eq(media.kind, 'photo')))
    // isMain first, then the agency's order, then insertion order as the
    // tie-break — without the last one a gallery of photos all added at
    // sortOrder 0 comes back in whatever order the planner felt like, which
    // changes between page loads.
    .orderBy(sql`${media.isMain} desc`, asc(media.sortOrder), asc(media.createdAt));

  return rows;
}

/**
 * Attach an uploaded file to a listing.
 *
 * `owner` is rebuilt from the session by the caller. The browser supplies the
 * key, and a key is a path — so it is checked against the listing it claims to
 * belong to before anything is written. Without that check a valid-looking key
 * for another agency's listing would be accepted, and the file it points at
 * would appear on this ad.
 */
export async function addListingPhoto(
  db: Db,
  listingId: string,
  storageKey: string,
  meta: { width?: number | null; height?: number | null; caption?: string | null } = {},
): Promise<{ mediaId: string }> {
  if (!keyBelongsTo(storageKey, { kind: 'listing', id: listingId })) {
    throw new MediaError('That image does not belong to this listing');
  }

  // Outside the transaction, deliberately: this is an HTTP call to storage.
  const object = await describeObject(storageKey);
  if (!object) {
    throw new MediaError('That image was not uploaded — try again');
  }

  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: listing.id })
      .from(listing)
      .where(eq(listing.id, listingId))
      .limit(1);
    if (!target) throw new MediaError('That listing no longer exists');

    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(media)
      .where(and(eq(media.listingId, listingId), eq(media.kind, 'photo')));

    if (count >= MAX_LISTING_PHOTOS) {
      throw new MediaError(`A listing can carry ${MAX_LISTING_PHOTOS} photos`);
    }

    const [row] = await tx
      .insert(media)
      .values({
        listingId,
        kind: 'photo',
        storageKey,
        width: meta.width ?? null,
        height: meta.height ?? null,
        caption: meta.caption ?? null,
        // The first photo on a listing is its main one. Nobody sets a cover
        // image before they have uploaded anything, and a gallery whose first
        // upload is not the cover reads as a bug.
        isMain: count === 0,
        sortOrder: count,
      })
      .returning({ id: media.id });

    if (!row) throw new MediaError('Could not record that image');
    return { mediaId: row.id };
  });
}

/**
 * Detach a photo, and only then remove the file.
 *
 * Scoped by listing id as well as media id: the caller has been authorised
 * against a listing, so the delete has to be constrained to that listing or
 * the authorisation means nothing.
 */
export async function removeListingPhoto(
  db: Db,
  listingId: string,
  mediaId: string,
): Promise<{ removed: boolean }> {
  const key = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: media.id, storageKey: media.storageKey, isMain: media.isMain })
      .from(media)
      .where(and(eq(media.id, mediaId), eq(media.listingId, listingId)))
      .limit(1);
    if (!row) return null;

    await tx.delete(media).where(eq(media.id, mediaId));

    /**
     * Promote a new cover when the old one goes.
     *
     * A listing with photos and no `is_main` renders with no hero image on
     * both public pages — the gallery and the results row both ask for the
     * main photo and get nothing, so deleting the cover silently emptied the
     * ad while leaving every other photo in place.
     */
    if (row.isMain) {
      const [next] = await tx
        .select({ id: media.id })
        .from(media)
        .where(and(eq(media.listingId, listingId), eq(media.kind, 'photo')))
        .orderBy(asc(media.sortOrder), asc(media.createdAt))
        .limit(1);
      if (next) {
        await tx.update(media).set({ isMain: true }).where(eq(media.id, next.id));
      }
    }

    return row.storageKey;
  });

  if (!key) return { removed: false };

  // After the row is gone. A failed object delete leaves a file nothing points
  // at; a failed row delete would leave an ad pointing at a file that is gone.
  await deleteObject(key).catch(() => false);
  return { removed: true };
}

/** Make one photo the cover. */
export async function setMainListingPhoto(
  db: Db,
  listingId: string,
  mediaId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: media.id })
      .from(media)
      .where(and(eq(media.id, mediaId), eq(media.listingId, listingId)))
      .limit(1);
    if (!row) throw new MediaError('That image is not on this listing');

    await tx
      .update(media)
      .set({ isMain: false })
      .where(and(eq(media.listingId, listingId), eq(media.isMain, true)));
    await tx.update(media).set({ isMain: true }).where(eq(media.id, mediaId));
  });
}

/**
 * The agent's portrait.
 *
 * Writes `photo_key`, not `photo_url`. The two coexist: `photo_url` is a link
 * an agency pasted at some point and may still be the only thing a profile
 * has, while `photo_key` is a file this platform holds. Readers prefer the
 * key — an upload is a deliberate act and beats a link typed once.
 */
export async function setAgentPhoto(
  db: Db,
  userId: string,
  storageKey: string,
): Promise<void> {
  if (!keyBelongsTo(storageKey, { kind: 'agent', id: userId })) {
    throw new MediaError('That image does not belong to this agent');
  }

  const object = await describeObject(storageKey);
  if (!object) throw new MediaError('That image was not uploaded — try again');

  const previous = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: agentProfile.id, photoKey: agentProfile.photoKey })
      .from(agentProfile)
      .where(eq(agentProfile.userId, userId))
      .limit(1);
    if (!row) throw new MediaError('That agent has no profile to attach a photo to');

    await tx
      .update(agentProfile)
      .set({ photoKey: storageKey })
      .where(eq(agentProfile.userId, userId));

    return row.photoKey;
  });

  // The replaced file, once the row no longer points at it. Nothing depends on
  // this succeeding.
  if (previous && previous !== storageKey) {
    await deleteObject(previous).catch(() => false);
  }
}

export async function clearAgentPhoto(db: Db, userId: string): Promise<void> {
  const previous = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ photoKey: agentProfile.photoKey })
      .from(agentProfile)
      .where(eq(agentProfile.userId, userId))
      .limit(1);
    if (!row?.photoKey) return null;
    await tx.update(agentProfile).set({ photoKey: null }).where(eq(agentProfile.userId, userId));
    return row.photoKey;
  });

  if (previous) await deleteObject(previous).catch(() => false);
}
