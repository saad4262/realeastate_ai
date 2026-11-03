'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { setWatching, watchButtonState, type WatchButtonState } from '../lib/watch-action';

/**
 * "Watch this address" (ADR 0080, C4 decision 2) — on a listing and on an address not for sale. It watches the
 * address, not the ad. A client island: it asks after the page renders, so the page stays cached for everyone.
 */
export function WatchButton({ propertyId, returnTo }: { propertyId: string; returnTo: string }) {
  const [state, setState] = useState<WatchButtonState | null>(null);
  const [error, setError] = useState<{ text: string; skillOff?: boolean } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    watchButtonState(propertyId)
      .then((s) => live && setState(s))
      .catch(() => live && setState({ signedIn: false }));
    return () => {
      live = false;
    };
  }, [propertyId]);

  const pill = 'inline-flex items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 text-body-sm font-semibold';
  if (!state) return <span className="inline-block h-9 w-32" aria-hidden />;
  if (!state.signedIn) {
    return (
      <Link href={`/login?next=${encodeURIComponent(returnTo)}`} className={`${pill} border-line text-ink hover:border-ink`}>
        <span aria-hidden>👁</span> Sign in to watch
      </Link>
    );
  }
  if (!state.monitorOn && !state.watching) {
    return (
      <Link href="/account/skills" className={`${pill} border-line text-ink-soft hover:border-ink`} title="Watching needs Property Monitor — turn it on in Skills">
        <span aria-hidden>👁</span> Watch — turn on Property Monitor
      </Link>
    );
  }

  function toggle() {
    if (!state?.signedIn) return;
    const next = !state.watching;
    setError(null);
    setState({ ...state, watching: next });
    start(async () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await setWatching(propertyId, next, tz);
      if (!r.ok) {
        setState({ ...state, watching: !next });
        setError({ text: r.error, ...(r.skillOff ? { skillOff: true } : {}) });
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" onClick={toggle} disabled={pending} aria-pressed={state.watching} className={`${pill} ${state.watching ? 'border-brand text-brand' : 'border-line text-ink hover:border-ink'}`}>
        <span aria-hidden>👁</span> {state.watching ? 'Watching' : 'Watch this address'}
      </button>
      {error ? (
        <span role="alert" className="text-label-sm text-alert">
          {error.text} {error.skillOff ? <Link href="/account/skills" className="underline">Open Skills</Link> : null}
        </span>
      ) : null}
    </span>
  );
}
