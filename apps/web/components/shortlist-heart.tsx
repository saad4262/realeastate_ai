'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { heartState, setSaved, type HeartState } from '../lib/shortlist-action';

/**
 * Save a home to the shortlist (ADR 0080, C4 decision 1). A client island on the cached listing page: it asks
 * the server whether this visitor saved it after the page has rendered, so the page stays cached for everyone.
 */
export function ShortlistHeart({ listingId }: { listingId: string }) {
  const [state, setState] = useState<HeartState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    heartState(listingId)
      .then((s) => live && setState(s))
      .catch(() => live && setState({ signedIn: false }));
    return () => {
      live = false;
    };
  }, [listingId]);

  if (!state) return <span className="inline-block h-9 w-24" aria-hidden />;
  if (!state.signedIn) {
    return (
      <Link href={`/login?next=${encodeURIComponent(`/listing/${listingId}`)}`} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-body-sm font-semibold text-ink hover:border-ink">
        <span aria-hidden>♡</span> Sign in to save
      </Link>
    );
  }

  function toggle() {
    if (!state?.signedIn) return;
    const next = !state.saved;
    setError(null);
    setState({ signedIn: true, saved: next });
    start(async () => {
      const r = await setSaved(listingId, next);
      if (!r.ok) {
        setState({ signedIn: true, saved: !next });
        setError(r.error);
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={state.saved}
        className={`inline-flex items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 text-body-sm font-semibold ${state.saved ? 'border-alert text-alert' : 'border-line text-ink hover:border-ink'}`}
      >
        <span aria-hidden>{state.saved ? '♥' : '♡'}</span> {state.saved ? 'Saved' : 'Save'}
      </button>
      {error ? <span role="alert" className="text-label-sm text-alert">{error}</span> : null}
    </span>
  );
}
