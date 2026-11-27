'use client';

import { useSyncExternalStore } from 'react';
import { restoreSaved, setSaved, type Removed } from './shortlist-action';

/**
 * Which homes this visitor saved, shared by every heart on the page (ADR 0100), and the one notice ("Saved",
 * "Removed · Undo") shown for it. No library: module-level snapshots behind `useSyncExternalStore`.
 *
 * - One `GET /api/shortlist` when the first heart mounts, however many cards the page has.
 * - Forgotten when the last heart unmounts, so every page reads fresh: a sign-in (a Server Action redirect,
 *   which keeps this module alive) or a removal on /account/shortlist is never shown stale.
 * - A press is optimistic and rolls back on failure. A second press on the same home waits out the first.
 * - A press before the read answers waits for it; a signed-out press is remembered across the sign-in and
 *   saved on the way back (`INTENT`), so "Sign in to save" does what it says.
 * - Notices have their own listeners, so the toaster on every page never starts a read by itself.
 */

export type SavedHomes = {
  /** False until the read answers, and after it fails. */
  loaded: boolean;
  signedIn: boolean;
  ids: ReadonlySet<string>;
  /** Homes with a save or remove in flight. */
  busy: ReadonlySet<string>;
};

export type Notice = {
  /** Changes with every notice, so the toaster restarts its timer even when the text repeats. */
  key: number;
  tone: 'done' | 'error';
  text: string;
  action?: { label: string; href: string } | { label: string; run: () => void };
};

const NONE: ReadonlySet<string> = new Set();
const INITIAL: SavedHomes = { loaded: false, signedIn: false, ids: NONE, busy: NONE };
const INTENT = 'saved-homes:intent';
/** A sign-in abandoned and finished much later is not a press any more. */
const INTENT_MS = 10 * 60_000;

let snap = INITIAL;
/** Bumped on every reset, so an answer meant for a page that is gone never lands on the next one. */
let generation = 0;
let ready: Promise<SavedHomes> | null = null;
const listeners = new Set<() => void>();
/** Writes still in flight: the next page's read waits for them, or it could read the list from before them. */
const writes = new Set<Promise<unknown>>();

function set(next: Partial<SavedHomes>) {
  snap = { ...snap, ...next };
  for (const l of listeners) l();
}

// ── notices ──
let notice: Notice | null = null;
let noticeKey = 0;
const noticeListeners = new Set<() => void>();

export function notify(next: Omit<Notice, 'key'> | null) {
  notice = next ? { ...next, key: ++noticeKey } : null;
  for (const l of noticeListeners) l();
}

export function useNotice(): Notice | null {
  return useSyncExternalStore(
    (l) => {
      noticeListeners.add(l);
      return () => noticeListeners.delete(l);
    },
    () => notice,
    () => null,
  );
}

const VIEW = { label: 'View saved', href: '/account/shortlist' } as const;

// ── the saved set ──
function session<T>(fn: (s: Storage) => T): T | null {
  try {
    return fn(window.sessionStorage);
  } catch {
    return null; // private mode or blocked storage: the press after sign-in is simply not remembered
  }
}

function load(): Promise<SavedHomes> {
  const gen = generation;
  return Promise.allSettled([...writes])
    .then(() => fetch('/api/shortlist', { cache: 'no-store', credentials: 'same-origin' }))
    .then((r) => (r.ok ? (r.json() as Promise<{ signedIn: boolean; ids: string[] }>) : Promise.reject(new Error(String(r.status)))))
    .then((body) => {
      if (gen !== generation) return snap;
      set({ loaded: true, signedIn: body.signedIn, ids: new Set(body.ids) });
      const [intent, at] = (body.signedIn ? session((s) => s.getItem(INTENT)) : null)?.split('|') ?? [];
      if (intent) {
        session((s) => s.removeItem(INTENT));
        if (Date.now() - Number(at) < INTENT_MS && !snap.ids.has(intent)) void toggleSaved(intent);
      }
      return snap;
    })
    .catch(() => snap); // stays not loaded: a press then says it could not reach the list
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  ready ??= load();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    generation += 1;
    ready = null;
    snap = INITIAL;
  };
}

export function useSavedHomes(): SavedHomes {
  return useSyncExternalStore(subscribe, () => snap, () => INITIAL);
}

/** The same store outside React: its test (saved-homes.test.ts) drives it through these. */
export const subscribeSavedHomes = subscribe;
export const savedHomesSnapshot = (): SavedHomes => snap;

function withId(ids: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(ids);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/** One write for one home: optimistic, rolled back on failure, never two at once for the same home. */
async function write<T extends { ok: true } | { ok: false; error: string }>(listingId: string, on: boolean, call: () => Promise<T>): Promise<T | null> {
  if (snap.busy.has(listingId)) return null;
  const gen = generation;
  const was = snap.ids.has(listingId);
  set({ ids: withId(snap.ids, listingId, on), busy: withId(snap.busy, listingId, true) });
  const pending = call().catch(() => ({ ok: false as const, error: 'Something went wrong. Try again.' }) as T);
  writes.add(pending);
  const result = await pending;
  writes.delete(pending);
  if (gen === generation) {
    const busy = withId(snap.busy, listingId, false);
    set(result.ok ? { busy } : { busy, ids: withId(snap.ids, listingId, was) });
  }
  if (!result.ok) notify({ tone: 'error', text: result.error });
  return result;
}

/** Save or unsave one home, and say so. */
export async function toggleSaved(listingId: string): Promise<void> {
  const save = !snap.ids.has(listingId);
  const result = await write(listingId, save, () => setSaved(listingId, save));
  if (!result?.ok) return;
  if (save) notify({ tone: 'done', text: 'Home saved', action: VIEW });
  else notify({ tone: 'done', text: 'Removed from saved homes', action: result.removed ? { label: 'Undo', run: () => void undoRemove(listingId, result.removed!) } : undefined });
}

/** Put a removed home back with its note and its place (ADR 0100). Also used by the Saved page's own list. */
export async function undoRemove(listingId: string, removed: Removed): Promise<boolean> {
  const result = await write(listingId, true, () => restoreSaved(listingId, removed));
  if (result?.ok) notify({ tone: 'done', text: 'Back in your saved homes', action: VIEW });
  return Boolean(result?.ok);
}

/**
 * A heart was pressed. Waits for the read if it has not answered; a signed-out visitor goes to sign in, with the
 * home remembered so it is saved when they come back. Answers where to send them, or null.
 */
export async function pressHeart(listingId: string): Promise<string | null> {
  const s = await (ready ?? Promise.resolve(snap));
  if (!s.loaded) {
    notify({ tone: 'error', text: 'Your saved homes could not be reached. Try again.' });
    return null;
  }
  if (!s.signedIn) {
    session((st) => st.setItem(INTENT, `${listingId}|${Date.now()}`));
    return `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  await toggleSaved(listingId);
  return null;
}
