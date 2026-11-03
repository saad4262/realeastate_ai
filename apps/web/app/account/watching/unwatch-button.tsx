'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setWatching } from '../../../lib/watch-action';

/** Stop watching — always allowed, Property Monitor on or off. Its history goes with it. */
export function UnwatchButton({ propertyId }: { propertyId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await setWatching(propertyId, false);
            if (r.ok) router.refresh();
            else setError(r.error);
          })
        }
        className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:border-ink"
      >
        Stop watching
      </button>
      {error ? <span className="text-xs text-alert">{error}</span> : null}
    </span>
  );
}
