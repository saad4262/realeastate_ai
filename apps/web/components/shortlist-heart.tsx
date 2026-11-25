'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toggleSaved, useSavedHomes } from '../lib/saved-homes';

/**
 * Save a home to the shortlist (ADR 0080 C4, ADR 0100), from any card or the listing page. A client island on
 * cached pages: every heart on the page reads one shared store (`lib/saved-homes`), so the page stays cached for
 * everyone and asks the server once, however many cards it draws.
 *
 * `pill` is the listing page's labelled button; `icon` is the round one on a card's photo, named by the address
 * so a page of twenty is not twenty buttons called "Save".
 */
export function ShortlistHeart({ listingId, look = 'pill', address }: { listingId: string; look?: 'pill' | 'icon'; address?: string }) {
  const { loaded, signedIn, ids, busy } = useSavedHomes();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // Nothing until the store answers: a guessed heart that flips a moment later reads as a bug.
  if (!loaded) return look === 'pill' ? <span className="inline-block h-9 w-24" aria-hidden /> : null;

  const saved = ids.has(listingId);
  const home = address ?? 'this home';

  async function press() {
    if (!signedIn) {
      // Read at press time, not render: the query string is part of where they were, and reading it while
      // rendering (useSearchParams) would push `/` off static rendering.
      router.push(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    setError(null);
    setError(await toggleSaved(listingId));
  }

  const heart = (
    <svg viewBox="0 0 24 24" className={look === 'icon' ? 'size-5' : 'size-4'} aria-hidden fill={saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinejoin="round">
      <path d="M12 20s-7-4.4-9.2-9A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 21.2 11C19 15.6 12 20 12 20Z" />
    </svg>
  );

  const alert = error ? (
    <span role="alert" className={look === 'icon' ? 'absolute right-0 top-full z-10 mt-1 w-max max-w-[14rem] rounded-sm bg-card px-2 py-1 text-label-sm text-alert shadow-raised' : 'text-label-sm text-alert'}>
      {error}
    </span>
  ) : null;

  if (look === 'icon') {
    return (
      <span className="relative">
        <button
          type="button"
          onClick={press}
          aria-pressed={signedIn ? saved : undefined}
          aria-label={signedIn ? `${saved ? 'Remove' : 'Save'} ${home}` : `Sign in to save ${home}`}
          aria-busy={busy.has(listingId)}
          title={signedIn ? (saved ? 'Saved' : 'Save') : 'Sign in to save'}
          className={`grid size-10 place-items-center rounded-full bg-card/95 shadow-card transition hover:scale-105 motion-reduce:transition-none ${saved ? 'text-alert' : 'text-ink'}`}
        >
          {heart}
        </button>
        {alert}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={press}
        aria-pressed={signedIn ? saved : undefined}
        aria-busy={busy.has(listingId)}
        className={`inline-flex items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 text-body-sm font-semibold ${saved ? 'border-alert text-alert' : 'border-line text-ink hover:border-ink'}`}
      >
        {heart} {!signedIn ? 'Sign in to save' : saved ? 'Saved' : 'Save'}
      </button>
      {alert}
    </span>
  );
}
