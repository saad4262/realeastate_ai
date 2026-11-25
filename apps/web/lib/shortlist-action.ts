'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { addToShortlist, MAX_NOTE, removeFromShortlist, restoreToShortlist, setShortlistNote, ShortlistError } from '@repo/core/shortlist';
import { ensureAppUser } from '@repo/core/identity';
import { getWebDb } from './db';
import { looksSignedIn, verifiedWebUserForAction } from './session';

/**
 * The shortlist's actions (ADR 0080, C4). Posted from the cached listing page, where middleware never runs, so
 * each one verifies the session itself (`verifiedWebUserForAction`) — and a visitor with no auth cookie at all
 * costs no check. The browser chooses a listing id and nothing else; core decides the rest under `can()`.
 */

export type ShortlistResult = { ok: true } | { ok: false; error: string };
/** What Undo needs to put a removed home back as it was. The date as ISO text, so it crosses the wire as itself. */
export type Removed = { note: string | null; savedAt: string };
export type SetSavedResult = { ok: true; removed: Removed | null } | { ok: false; error: string };

async function buyer() {
  if (!(await looksSignedIn())) return null;
  const user = await verifiedWebUserForAction();
  if (!user) return null;
  // The `public.user` row the shortlist's foreign key needs (a magic-link account may not have one yet).
  await ensureAppUser(getWebDb(), { id: user.id, email: user.email ?? '', ...(user.label ? { name: user.label } : {}) });
  return { userId: user.id };
}

async function run<T>(fn: (actor: { userId: string }) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const actor = await buyer();
  if (!actor) return { ok: false, error: 'Sign in to save homes.' };
  try {
    const value = await fn(actor);
    revalidatePath('/account/shortlist');
    return { ok: true, value };
  } catch (err) {
    if (err instanceof ShortlistError) return { ok: false, error: err.message };
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

const done = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): ShortlistResult => (r.ok ? { ok: true } : r);

export async function setSaved(listingId: string, saved: boolean): Promise<SetSavedResult> {
  const r = await run(async (actor) => {
    if (saved) return void (await addToShortlist(getWebDb(), actor, listingId));
    return removeFromShortlist(getWebDb(), actor, listingId);
  });
  if (!r.ok) return r;
  return { ok: true, removed: r.value ? { note: r.value.note, savedAt: r.value.savedAt.toISOString() } : null };
}

/** Undo a removal (ADR 0100). The browser hands back what `setSaved` gave it, so it is parsed as any input is. */
const RemovedInput = z.object({ note: z.string().max(MAX_NOTE).nullable(), savedAt: z.string().datetime({ offset: true }) });

export async function restoreSaved(listingId: string, removed: Removed): Promise<ShortlistResult> {
  const parsed = RemovedInput.safeParse(removed);
  if (!parsed.success) return { ok: false, error: 'That cannot be undone now.' };
  return done(await run((actor) => restoreToShortlist(getWebDb(), actor, listingId, { note: parsed.data.note, savedAt: new Date(parsed.data.savedAt) })));
}

export async function saveNote(listingId: string, note: string): Promise<ShortlistResult> {
  return done(await run((actor) => setShortlistNote(getWebDb(), actor, listingId, String(note ?? ''))));
}
