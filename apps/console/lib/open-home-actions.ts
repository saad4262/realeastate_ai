'use server';

import { revalidatePath } from 'next/cache';
import { OpenHomeError, addOpenHomes, copyOpenHomeNextWeek, removeOpenHome, updateOpenHome } from '@repo/core/inspections';
import type { OpenHomeInput } from '@repo/core/inspections/open-home-rules';
import { getConsoleDb } from './db';
import { loadListingActor } from './load-actor';
import { requireActionUserId } from './auth-account';
import { revalidateWeb } from './revalidate-web';

/**
 * A listing's open homes (ADR 0081). The same three steps as the listing actions: the actor from the session, `listing:edit` inside
 * packages/core, then the public site's cache. `confirm` is the "Is this right?" question, answered by sending it again.
 */

export type OpenHomeResult = { ok: true } | { ok: false; error: string; confirm?: boolean };

async function run(listingId: string, write: (actor: NonNullable<Awaited<ReturnType<typeof loadListingActor>>>) => Promise<unknown>): Promise<OpenHomeResult> {
  try {
    const userId = await requireActionUserId();
    const actor = await loadListingActor(userId);
    if (!actor) return { ok: false, error: 'Database is not configured.' };
    await write(actor);
    revalidatePath(`/live-listings/${listingId}/edit`);
    revalidatePath(`/listings/${listingId}/edit`);
    await revalidateWeb(listingId);
    return { ok: true };
  } catch (err) {
    if (err instanceof OpenHomeError) return { ok: false, error: err.message, ...(err.confirm ? { confirm: true } : {}) };
    console.error('[open-homes] action failed', err);
    return { ok: false, error: 'That time could not be saved. Try again.' };
  }
}

export async function addOpenHomesAction(listingId: string, input: OpenHomeInput): Promise<OpenHomeResult> {
  return run(listingId, (actor) => addOpenHomes(getConsoleDb(), actor, listingId, input));
}

export async function updateOpenHomeAction(listingId: string, id: string, input: OpenHomeInput): Promise<OpenHomeResult> {
  return run(listingId, (actor) => updateOpenHome(getConsoleDb(), actor, listingId, id, input));
}

export async function removeOpenHomeAction(listingId: string, id: string): Promise<OpenHomeResult> {
  return run(listingId, (actor) => removeOpenHome(getConsoleDb(), actor, listingId, id));
}

export async function copyOpenHomeNextWeekAction(listingId: string, id: string): Promise<OpenHomeResult> {
  return run(listingId, (actor) => copyOpenHomeNextWeek(getConsoleDb(), actor, listingId, id));
}
