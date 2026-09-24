'use server';

import { revalidatePath } from 'next/cache';
import {
  createListing,
  deleteListing,
  setListingStatus,
  toListingError,
  updateListing,
  type ListingErrorCode,
  type ListingStatus,
} from '@repo/core/listings';
import {
  resolvePlace,
  reverseGeocode,
  suggestPlaces,
  type PlaceKind,
  type PlaceSuggestion,
} from '@repo/core/geo';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireAuthAccount } from './auth-account';
import { revalidateWeb } from './revalidate-web';

export type CreateListingActionResult =
  | { ok: true; listingId: string; propertyId: string }
  | { ok: false; error: string; code: ListingErrorCode; field?: string };

/**
 * Both surfaces post here. The actor is rebuilt from the session rather than
 * taken from the caller, so the agency a listing lands in is never something
 * the browser gets to choose.
 */
export async function createListingAction(
  input: unknown,
): Promise<CreateListingActionResult> {
  // Outside the try: a missing session throws, and catching that would turn
  // "not signed in" into a confusing "could not save the listing".
  const account = await requireAuthAccount();

  try {
    const actor = await loadListingActor(account.userId);
    if (!actor) {
      return {
        ok: false,
        error: 'Database is not configured — listings cannot be saved.',
        code: 'unknown',
      };
    }

    const result = await createListing(getConsoleDb(), actor, input);

    revalidatePath('/live-listings');
    revalidatePath('/listings');
    // A draft is not public, so nothing to clear there yet — but the suburb and
    // property-type filter lists are built from live listings and this may be
    // the first one in a new suburb once it is published.
    await revalidateWeb();

    return { ok: true, listingId: result.listingId, propertyId: result.propertyId };
  } catch (err) {
    // Never hand a raw ZodError to the UI — it serialises as a JSON issue array.
    const e = toListingError(err);
    return { ok: false, error: e.message, code: e.code, field: e.field };
  }
}

export type SetStatusActionResult =
  | { ok: true; status: ListingStatus }
  | { ok: false; error: string; code: ListingErrorCode };

/** Publish or withdraw. Separate from creation — non-negotiable #7. */
export async function setListingStatusAction(
  listingId: string,
  next: 'draft' | 'live' | 'under_offer' | 'withdrawn',
): Promise<SetStatusActionResult> {
  const account = await requireAuthAccount();

  try {
    // loadListingActor, not loadActor: listing:publish consults listing_agent
    // for anyone who is not an agency admin.
    const actor = await loadListingActor(account.userId);
    if (!actor) {
      return { ok: false, error: 'Database is not configured.', code: 'unknown' };
    }

    const result = await setListingStatus(getConsoleDb(), actor, listingId, next);

    revalidatePath('/live-listings');
    revalidatePath('/listings');
    // Publishing and withdrawing are exactly the moments the public site is
    // wrong until it is told.
    await revalidateWeb(listingId);

    return { ok: true, status: result.status };
  } catch (err) {
    const e = toListingError(err);
    return { ok: false, error: e.message, code: e.code };
  }
}

export type UpdateListingActionResult =
  | { ok: true; listingId: string; addressChanged: boolean }
  | { ok: false; error: string; code: ListingErrorCode; field?: string };

/**
 * Edit an existing listing.
 *
 * The listing id comes from the caller but the agency never does: the actor is
 * rebuilt from the session, and updateListing refuses anything outside it. An
 * id belonging to another agency is a "not found", not an edit.
 */
export async function updateListingAction(
  listingId: string,
  input: unknown,
): Promise<UpdateListingActionResult> {
  const account = await requireAuthAccount();

  try {
    // loadListingActor, not loadActor: listing:edit consults listing_agent for
    // anyone who is not an agency admin.
    const actor = await loadListingActor(account.userId);
    if (!actor) {
      return { ok: false, error: 'Database is not configured.', code: 'unknown' };
    }

    const result = await updateListing(getConsoleDb(), actor, listingId, input);

    revalidatePath('/live-listings');
    revalidatePath('/listings');
    revalidatePath(`/live-listings/${listingId}/edit`);
    revalidatePath(`/listings/${listingId}/edit`);
    await revalidateWeb(listingId);

    return { ok: true, listingId: result.listingId, addressChanged: result.addressChanged };
  } catch (err) {
    const e = toListingError(err);
    return { ok: false, error: e.message, code: e.code, field: e.field };
  }
}

export type DeleteListingActionResult =
  | { ok: true; listingId: string }
  | { ok: false; error: string; code: ListingErrorCode };

/**
 * Delete a listing for good.
 *
 * Admin-only, and refused outright for anything live, under offer or sold —
 * both decisions live in packages/core, not here, so the rule is the same
 * however it is reached.
 */
export async function deleteListingAction(
  listingId: string,
): Promise<DeleteListingActionResult> {
  const account = await requireAuthAccount();

  try {
    const actor = await loadListingActor(account.userId);
    if (!actor) {
      return { ok: false, error: 'Database is not configured.', code: 'unknown' };
    }

    const result = await deleteListing(getConsoleDb(), actor, listingId);

    revalidatePath('/live-listings');
    revalidatePath('/listings');
    await revalidateWeb(listingId);

    return { ok: true, listingId: result.listingId };
  } catch (err) {
    const e = toListingError(err);
    return { ok: false, error: e.message, code: e.code };
  }
}

/**
 * Address autocomplete for the listing form and the territory picker.
 *
 * A server action rather than a route handler so the provider key stays on the
 * server and the browser never learns it exists. Returns an empty list rather
 * than an error on any failure: a dropdown that cannot suggest is a dropdown
 * the agent types past, not a broken form.
 */
export async function suggestPlacesAction(
  query: string,
  kinds?: PlaceKind[],
): Promise<PlaceSuggestion[]> {
  // Signed-in only. Without this the action is an open, billable proxy to a
  // paid geocoder that anyone who reads the page source can call.
  await requireAuthAccount();

  try {
    return await suggestPlaces(getConsoleDb(), query, { kinds });
  } catch {
    return [];
  }
}

/**
 * Turn a chosen suggestion into an address with coordinates.
 *
 * Returned to the browser so the form can fill its own fields and hand the
 * coordinates back on save — which is what stops the server geocoding an
 * address the provider pinned thirty seconds ago.
 */
export async function resolvePlaceAction(id: string) {
  await requireAuthAccount();

  try {
    return await resolvePlace(getConsoleDb(), id);
  } catch {
    return null;
  }
}

/**
 * A point on the map back to an address.
 *
 * What makes a dragged pin checkable: the agent moves the marker and is told
 * which address they landed on, rather than being left with two numbers.
 * Returns null rather than throwing — a pin the geocoder cannot name is still
 * a valid pin, and the agent may well know better than it does.
 */
export async function reverseGeocodeAction(lat: number, lng: number) {
  await requireAuthAccount();

  try {
    return await reverseGeocode(getConsoleDb(), lat, lng);
  } catch {
    return null;
  }
}
