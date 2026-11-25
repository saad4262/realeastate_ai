'use client';

import { useSyncExternalStore } from 'react';
import { setSaved } from './shortlist-action';

/**
 * Which homes this visitor saved, shared by every heart on the page (ADR 0100). No library: a module-level
 * snapshot behind `useSyncExternalStore`.
 *
 * - One `GET /api/shortlist` when the first heart mounts, however many cards the page has.
 * - Forgotten when the last heart unmounts, so every page reads fresh: a sign-in (a Server Action redirect,
 *   which keeps this module alive) or a removal on /account/shortlist is never shown stale.
 * - A press is optimistic, rolls back on failure, and is ignored while that home's last press is in flight.
 */

export type SavedHomes = {
  /** False until the read answers, and after it fails: a heart then shows nothing rather than guess. */
  loaded: boolean;
  signedIn: boolean;
  ids: ReadonlySet<string>;
  /** Homes with a save or remove in flight. */
  busy: ReadonlySet<string>;
};

const NONE: ReadonlySet<string> = new Set();
const INITIAL: SavedHomes = { loaded: false, signedIn: false, ids: NONE, busy: NONE };

let snap = INITIAL;
/** Bumped on every reset, so an answer meant for a page that is gone never lands on the next one. */
let generation = 0;
let loading = false;
const listeners = new Set<() => void>();
/** Writes still in flight: the next page's read waits for them, or it could read the list from before them. */
const writes = new Set<Promise<unknown>>();

function set(next: Partial<SavedHomes>) {
  snap = { ...snap, ...next };
  for (const l of listeners) l();
}

function load() {
  loading = true;
  const gen = generation;
  Promise.allSettled([...writes])
    .then(() => fetch('/api/shortlist', { cache: 'no-store', credentials: 'same-origin' }))
    .then((r) => (r.ok ? (r.json() as Promise<{ signedIn: boolean; ids: string[] }>) : Promise.reject(new Error(String(r.status)))))
    .then((body) => {
      if (gen === generation) set({ loaded: true, signedIn: body.signedIn, ids: new Set(body.ids) });
    })
    .catch(() => {
      // Stays not loaded: no heart is drawn rather than a wrong one. The next page tries again.
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loading) load();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    generation += 1;
    loading = false;
    snap = INITIAL;
  };
}

export function useSavedHomes(): SavedHomes {
  return useSyncExternalStore(subscribe, () => snap, () => INITIAL);
}

function withId(ids: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(ids);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/** Save or unsave one home. Answers the error to show, or null. */
export async function toggleSaved(listingId: string): Promise<string | null> {
  if (!snap.loaded || !snap.signedIn || snap.busy.has(listingId)) return null;
  const save = !snap.ids.has(listingId);
  const gen = generation;
  set({ ids: withId(snap.ids, listingId, save), busy: withId(snap.busy, listingId, true) });

  const write = setSaved(listingId, save).catch(() => ({ ok: false as const, error: 'Something went wrong. Try again.' }));
  writes.add(write);
  const result = await write;
  writes.delete(write);

  if (gen === generation) {
    const busy = withId(snap.busy, listingId, false);
    set(result.ok ? { busy } : { busy, ids: withId(snap.ids, listingId, !save) });
  }
  return result.ok ? null : result.error;
}
