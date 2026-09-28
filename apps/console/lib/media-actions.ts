'use server';

import { revalidatePath } from 'next/cache';
import { can } from '@repo/core/permissions';
import {
  MAX_MEDIA_BYTES,
  MEDIA_MIME_TYPES,
  MediaError,
  addListingPhoto,
  assertCanEditAgentPhoto,
  assertCanEditListingMedia,
  clearAgentPhoto,
  newStorageKey,
  removeListingPhoto,
  setAgentPhoto,
  setMainListingPhoto,
  storageKeySchema,
} from '@repo/core/media';
import { signUpload } from '@repo/core/media/storage';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';
import { revalidateWeb } from './revalidate-web';

/**
 * Image upload, in two calls.
 *
 * The browser never sends the file here. It asks for permission, gets a signed
 * URL scoped to one key, PUTs the bytes straight to Supabase Storage, and then
 * asks this to record the row. See packages/core/src/media/storage-client.ts
 * for why: a Server Action body is capped at 1 MB by default, property photos
 * are several, and proxying them would move every byte twice.
 *
 * That shape means the second call cannot trust the first. "I uploaded to this
 * key" is a claim from a browser, so `addListingPhoto` HEADs the object before
 * it writes anything — a caller that skips the upload and calls straight
 * through gets a refusal, not an empty row pointing at a 404.
 *
 * Every function here follows the same three steps as the listing actions:
 * rebuild the actor from the session, ask can() through packages/core, then
 * act. The agency is never a parameter.
 */

type Ok<T = unknown> = { ok: true } & T;
type Fail = { ok: false; error: string };
/** For the actions that return nothing but "it worked". */
type Done = { ok: true } | Fail;

function fail(err: unknown): Fail {
  if (err instanceof MediaError) return { ok: false, error: err.message };
  console.error('[media] action failed', err);
  return { ok: false, error: 'That image could not be saved. Try again.' };
}

/**
 * Checked here as well as in the bucket.
 *
 * The bucket enforces its own allowlist and size cap — verified: a text/plain
 * upload is refused with 415 before RLS is even consulted. This is the earlier,
 * kinder refusal: telling someone their 40 MB TIFF is too big before they wait
 * for it to upload, rather than after.
 */
function checkFile(file: { type: string; size: number }): void {
  if (!MEDIA_MIME_TYPES[file.type.toLowerCase()]) {
    throw new MediaError('Images only — JPEG, PNG, WebP or AVIF');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new MediaError('That file is empty');
  }
  if (file.size > MAX_MEDIA_BYTES) {
    throw new MediaError('Images must be 10 MB or smaller');
  }
}

async function actorOrThrow() {
  const userId = await requireActionUserId();
  const actor = await loadListingActor(userId);
  if (!actor) throw new MediaError('Database is not configured.');
  return actor;
}

/* ------------------------------------------------------ listing photos -- */

export type SignUploadResult = Ok<{ uploadUrl: string; token: string; key: string }> | Fail;

/**
 * Permission first, then a URL that can only write to one path.
 *
 * The key is generated HERE, from the listing id the actor was just authorised
 * against — never taken from the browser. That is what makes the signed URL
 * safe to hand out: it is scoped by Supabase to the exact path it was signed
 * for, and that path is one this server chose.
 */
export async function signListingPhotoUploadAction(
  listingId: string,
  file: { type: string; size: number },
): Promise<SignUploadResult> {
  try {
    const actor = await actorOrThrow();
    const db = getConsoleDb();
    await assertCanEditListingMedia(db, actor, listingId);
    checkFile(file);

    const key = newStorageKey({ kind: 'listing', id: listingId }, file.type);
    const { uploadUrl, token } = await signUpload(key);
    return { ok: true, uploadUrl, token, key };
  } catch (err) {
    return fail(err);
  }
}

export type AttachPhotoResult = Ok<{ mediaId: string }> | Fail;

export async function attachListingPhotoAction(
  listingId: string,
  key: string,
  dimensions?: { width?: number; height?: number },
): Promise<AttachPhotoResult> {
  try {
    const actor = await actorOrThrow();
    const db = getConsoleDb();
    await assertCanEditListingMedia(db, actor, listingId);

    // Re-parsed even though this server issued it: it has been to a browser
    // and back. addListingPhoto checks it belongs to this listing too.
    const parsed = storageKeySchema.safeParse(key);
    if (!parsed.success) throw new MediaError('That is not an image this platform issued');

    const result = await addListingPhoto(db, listingId, parsed.data, {
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    });

    await refreshListing(listingId);
    return { ok: true, mediaId: result.mediaId };
  } catch (err) {
    return fail(err);
  }
}

export async function removeListingPhotoAction(
  listingId: string,
  mediaId: string,
): Promise<Done> {
  try {
    const actor = await actorOrThrow();
    const db = getConsoleDb();
    await assertCanEditListingMedia(db, actor, listingId);

    const { removed } = await removeListingPhoto(db, listingId, mediaId);
    if (!removed) throw new MediaError('That image is no longer on this listing');

    await refreshListing(listingId);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function setListingCoverAction(
  listingId: string,
  mediaId: string,
): Promise<Done> {
  try {
    const actor = await actorOrThrow();
    const db = getConsoleDb();
    await assertCanEditListingMedia(db, actor, listingId);

    await setMainListingPhoto(db, listingId, mediaId);
    await refreshListing(listingId);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/**
 * The cover photo is on every card of every search result, so a change here is
 * not confined to the property page — the listings tag has to go as well as
 * the per-listing one, which is what revalidateWeb(listingId) does.
 */
async function refreshListing(listingId: string): Promise<void> {
  revalidatePath('/live-listings');
  revalidatePath('/listings');
  revalidatePath(`/live-listings/${listingId}/edit`);
  revalidatePath(`/listings/${listingId}/edit`);
  await revalidateWeb(listingId);
}

/* -------------------------------------------------------- agent photos -- */

export async function signAgentPhotoUploadAction(
  agentUserId: string,
  file: { type: string; size: number },
): Promise<SignUploadResult> {
  try {
    const actor = await actorOrThrow();
    const db = getConsoleDb();
    await assertCanEditAgentPhoto(db, actor, agentUserId);
    checkFile(file);

    const key = newStorageKey({ kind: 'agent', id: agentUserId }, file.type);
    const { uploadUrl, token } = await signUpload(key);
    return { ok: true, uploadUrl, token, key };
  } catch (err) {
    return fail(err);
  }
}

export async function attachAgentPhotoAction(
  agentUserId: string,
  key: string,
): Promise<Done> {
  try {
    const actor = await actorOrThrow();
    const db = getConsoleDb();
    await assertCanEditAgentPhoto(db, actor, agentUserId);

    const parsed = storageKeySchema.safeParse(key);
    if (!parsed.success) throw new MediaError('That is not an image this platform issued');

    await setAgentPhoto(db, agentUserId, parsed.data);
    await refreshTeam();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function clearAgentPhotoAction(
  agentUserId: string,
): Promise<Done> {
  try {
    const actor = await actorOrThrow();
    const db = getConsoleDb();
    await assertCanEditAgentPhoto(db, actor, agentUserId);

    await clearAgentPhoto(db, agentUserId);
    await refreshTeam();
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/**
 * An agent's portrait appears on every listing they are named on, so the whole
 * listings tag goes — not one listing's.
 */
async function refreshTeam(): Promise<void> {
  revalidatePath('/team');
  await revalidateWeb();
}

/* --------------------------------------------- onboarding wizard photo -- */

/**
 * A headshot uploaded before the agent exists.
 *
 * The wizard's draft lives in the browser — there is no user id and no
 * agent_profile row yet — so the file is keyed on the **agency**, which comes
 * from the session and is the only stable id at that moment. It is also the
 * honest owner: the agency uploaded it, before anyone accepted anything.
 *
 * Authorised by `team:manage`, the same permission that lets someone run the
 * wizard at all. Not `assertCanEditAgentPhoto` — there is no agent to check
 * against, and inventing a placeholder id to satisfy that function would be a
 * check that looks like one and is not.
 *
 * `inviteAgent` writes the key onto the agent_profile row it creates. A later
 * upload from the team drawer replaces it with an agent-scoped key and deletes
 * this file.
 *
 * Known cost: a wizard someone abandons leaves the object behind. Nothing
 * points at it and it is invisible; collecting those is a job for later, not a
 * reason to make the upload wait for a row that does not exist yet.
 */
export async function signOnboardingPhotoUploadAction(
  file: { type: string; size: number },
): Promise<SignUploadResult> {
  try {
    const actor = await actorOrThrow();
    if (!actor.agencyId) throw new MediaError('No agency on this session');

    const allowed = can(actor, 'team:manage', { type: 'team', agencyId: actor.agencyId });
    if (!allowed) throw new MediaError('You cannot add agents to this agency');

    checkFile(file);

    const key = newStorageKey({ kind: 'agency', id: actor.agencyId }, file.type);
    const { uploadUrl, token } = await signUpload(key);
    return { ok: true, uploadUrl, token, key };
  } catch (err) {
    return fail(err);
  }
}
