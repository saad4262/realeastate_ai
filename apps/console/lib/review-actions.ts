'use server';

import { revalidatePath } from 'next/cache';
import { clearAgencyGooglePlace, ReviewError, searchGooglePlaces, setAgencyGooglePlace, type PlaceHit } from '@repo/core/reviews';
import { getConsoleDb } from './db';
import { loadActor } from './load-actor';
import { requireActionUserId } from './auth-account';

type Fail = { ok: false; error: string };

async function sessionActor() {
  return loadActor(await requireActionUserId());
}

function failure(err: unknown): Fail {
  if (err instanceof ReviewError) return { ok: false, error: err.message };
  throw err;
}

/** Search Google for the agency's listing (ADR 0028): owner/admin, server-side key — core decides. */
export async function searchPlacesAction(query: string): Promise<{ ok: true; hits: PlaceHit[] } | Fail> {
  const actor = await sessionActor();
  if (!actor) return { ok: false, error: 'Database is not configured.' };
  try {
    return { ok: true, hits: await searchGooglePlaces(actor, String(query ?? '')) };
  } catch (err) {
    return failure(err);
  }
}

/** Pick it: only the place id is stored. */
export async function pickPlaceAction(placeId: string): Promise<{ ok: true } | Fail> {
  const actor = await sessionActor();
  if (!actor) return { ok: false, error: 'Database is not configured.' };
  try {
    await setAgencyGooglePlace(getConsoleDb(), actor, placeId);
    revalidatePath('/settings/reviews');
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

export async function clearPlaceAction(): Promise<{ ok: true } | Fail> {
  const actor = await sessionActor();
  if (!actor) return { ok: false, error: 'Database is not configured.' };
  try {
    await clearAgencyGooglePlace(getConsoleDb(), actor);
    revalidatePath('/settings/reviews');
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}
