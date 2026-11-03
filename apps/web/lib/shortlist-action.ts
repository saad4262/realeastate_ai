'use server';

import { revalidatePath } from 'next/cache';
import { addToShortlist, removeFromShortlist, setShortlistNote, shortlistedAmong, ShortlistError } from '@repo/core/shortlist';
import { ensureAppUser } from '@repo/core/identity';
import { getWebDb } from './db';
import { looksSignedIn, verifiedWebUserForAction } from './session';

/**
 * The shortlist's actions (ADR 0080, C4). Posted from the cached listing page, where middleware never runs, so
 * each one verifies the session itself (`verifiedWebUserForAction`) — and a visitor with no auth cookie at all
 * costs no check. The browser chooses a listing id and nothing else; core decides the rest under `can()`.
 */

export type HeartState = { signedIn: false } | { signedIn: true; saved: boolean };
export type ShortlistResult = { ok: true } | { ok: false; error: string };

async function buyer() {
  if (!(await looksSignedIn())) return null;
  const user = await verifiedWebUserForAction();
  if (!user) return null;
  // The `public.user` row the shortlist's foreign key needs (a magic-link account may not have one yet).
  await ensureAppUser(getWebDb(), { id: user.id, email: user.email ?? '', ...(user.label ? { name: user.label } : {}) });
  return { userId: user.id };
}

export async function heartState(listingId: string): Promise<HeartState> {
  const actor = await buyer();
  if (!actor) return { signedIn: false };
  return { signedIn: true, saved: (await shortlistedAmong(getWebDb(), actor, [listingId])).has(listingId) };
}

async function run(fn: (actor: { userId: string }) => Promise<void>): Promise<ShortlistResult> {
  const actor = await buyer();
  if (!actor) return { ok: false, error: 'Sign in to save homes.' };
  try {
    await fn(actor);
    revalidatePath('/account/shortlist');
    return { ok: true };
  } catch (err) {
    if (err instanceof ShortlistError) return { ok: false, error: err.message };
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

export async function setSaved(listingId: string, saved: boolean): Promise<ShortlistResult> {
  return run((actor) => (saved ? addToShortlist(getWebDb(), actor, listingId) : removeFromShortlist(getWebDb(), actor, listingId)));
}

export async function saveNote(listingId: string, note: string): Promise<ShortlistResult> {
  return run((actor) => setShortlistNote(getWebDb(), actor, listingId, String(note ?? '')));
}
