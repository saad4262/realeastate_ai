'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { pressHeart, useSavedHomes } from '../lib/saved-homes';
import styles from './shortlist-heart.module.css';

/**
 * Save a home to the shortlist (ADR 0080 C4, ADR 0100), from any card or the listing page. A client island on
 * cached pages: every heart reads one shared store (`lib/saved-homes`), so the page stays cached for everyone
 * and asks the server once, however many cards it draws. What happened is said once, by the toaster.
 *
 * Drawn empty from the first paint, so nothing pops in; it fills when the store knows. `pill` is the listing
 * page's labelled button; `icon` is the round one on a card's photo, named by the address so a page of twenty
 * is not twenty buttons called "Save".
 */
export function ShortlistHeart({ listingId, look = 'pill', address }: { listingId: string; look?: 'pill' | 'icon'; address?: string }) {
  const { loaded, signedIn, ids, busy } = useSavedHomes();
  const router = useRouter();
  const [pop, setPop] = useState(0);

  const saved = ids.has(listingId);
  const home = address ?? 'this home';
  const known = loaded && signedIn;

  async function press() {
    if (!saved) setPop((n) => n + 1);
    const next = await pressHeart(listingId);
    if (next) router.push(next);
  }

  const heart = (
    <svg
      key={pop}
      viewBox="0 0 24 24"
      className={`${look === 'icon' ? 'size-5' : 'size-4'} ${pop ? styles.pop : ''}`}
      aria-hidden
      fill={saved ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinejoin="round"
    >
      <path d="M12 20s-7-4.4-9.2-9A4.8 4.8 0 0 1 12 6.6 4.8 4.8 0 0 1 21.2 11C19 15.6 12 20 12 20Z" />
    </svg>
  );

  const common = {
    type: 'button' as const,
    onClick: press,
    'aria-pressed': known ? saved : undefined,
    'aria-busy': busy.has(listingId) || undefined,
  };

  if (look === 'icon') {
    return (
      <button
        {...common}
        aria-label={loaded && !signedIn ? `Sign in to save ${home}` : `${saved ? 'Saved' : 'Save'} ${home}`}
        title={loaded && !signedIn ? 'Sign in to save' : saved ? 'Remove from saved' : 'Save'}
        className={[
          'grid size-10 place-items-center rounded-full bg-card/95 shadow-card backdrop-blur-sm transition',
          'hover:scale-110 hover:bg-card active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
          saved ? 'text-alert' : 'text-ink',
        ].join(' ')}
      >
        {heart}
      </button>
    );
  }

  return (
    <button
      {...common}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-body-sm font-semibold transition motion-reduce:transition-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
        saved ? 'border-alert text-alert' : 'border-line text-ink hover:border-ink',
      ].join(' ')}
    >
      {heart} {loaded && !signedIn ? 'Sign in to save' : saved ? 'Saved' : 'Save'}
    </button>
  );
}
