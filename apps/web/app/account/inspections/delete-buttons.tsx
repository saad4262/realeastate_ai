'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { removeAllNotebooks, removeNotebook } from './actions';

/** Delete one home's notes, or all of them — always allowed, skill on or off; photos go with them. */
export function DeleteNotebookButton({ listingId, all = false, after }: { listingId?: string; all?: boolean; after?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const question = all ? 'Delete all your inspection notes and photos? This cannot be undone.' : 'Delete your notes and photos for this home? This cannot be undone.';
  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(question)) return;
          start(async () => {
            const r = all ? await removeAllNotebooks() : await removeNotebook(listingId!);
            if (!r.ok) return setError(r.error);
            if (after) router.push(after);
            else router.refresh();
          });
        }}
        className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-alert hover:border-alert"
      >
        {pending ? 'Deleting…' : all ? 'Delete all my inspection notes' : 'Delete this home’s notes'}
      </button>
      {error ? <span className="text-xs text-alert">{error}</span> : null}
    </span>
  );
}
