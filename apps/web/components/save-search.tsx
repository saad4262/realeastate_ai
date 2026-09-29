'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { createScheduleAction } from '../app/alerts/actions';
import { ScheduleAccuracyNote, SchedulePicker } from './schedule-picker';
import { Spinner } from './spinner';



/**
 * Save the search currently on screen.
 *
 * It sends the `searchPath` — the link, not the filters. The server parses
 * it with the same vocabulary /search parses, so what gets saved is what
 * produced the results being looked at, and a browser cannot hand over
 * filters the person never saw (§ 9). That matters more than usual here,
 * because the thing being created sends email in their name.
 *
 * `signedIn` only decides what this renders. The action refuses on its own.
 */
export function SaveSearch({
  searchPath,
  signedIn,
  hasFilters,
  prompt,
  label = 'Save this search',
  compact = false,
}: {
  searchPath: string;
  signedIn: boolean;
  hasFilters: boolean;
  /**
   * The sentence the person typed, when they came from the chat.
   *
   * Stored beside the frozen query and shown back to them; it is never
   * re-interpreted (ADR 0010). `/search` has no sentence to pass, which is
   * the one thing the chat path can offer that the filter path cannot.
   */
  prompt?: string;
  label?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A schedule with no filters is "email me every listing, daily" — a valid
  // search page and a useless alert. The server refuses it too.
  if (!hasFilters) return null;

  if (!signedIn) {
    return (
      <Link
        href={`/login?next=${encodeURIComponent(searchPath)}`}
        className="rounded-full border border-line bg-card px-4 py-2 text-sm font-semibold text-ink hover:border-line-strong"
      >
        {label}
      </Link>
    );
  }

  if (saved) {
    return (
      <span className="flex items-center gap-2 text-sm text-success">
        Saved.{' '}
        <Link href="/alerts" className="rounded-full bg-ink px-3 py-1.5 text-xs font-semibold text-canvas">
          Turn off
        </Link>
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          compact
            ? 'w-full rounded-full border border-line bg-card px-4 py-2 text-sm font-semibold text-ink hover:border-line-strong'
            : 'rounded-full border border-line bg-card px-4 py-2 text-sm font-semibold text-ink hover:border-line-strong'
        }
      >
        {label}
      </button>
    );
  }

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await createScheduleAction(formData);
          if (result.ok) {
            setSaved(true);
            setOpen(false);
          } else {
            setError(result.error);
          }
        });
      }}
      className="w-full rounded-2xl border border-line bg-card p-4 shadow-[0_1px_2px_rgba(11,61,46,0.04)]"
    >
      <input type="hidden" name="searchPath" value={searchPath} />
      {prompt ? <input type="hidden" name="prompt" value={prompt} /> : null}

      <p className="text-sm font-medium text-ink">Run this search for me</p>
      <p className="mt-0.5 text-xs text-ink-soft">
        We will email you only when something new matches. Every email has a one-click
        unsubscribe.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-ink-soft">Name it</span>
          <input
            name="name"
            maxLength={120}
            defaultValue={prompt ? prompt.slice(0, 120) : undefined}
            placeholder="Pakenham rentals"
            className="mt-1 w-full rounded-xl border border-line bg-canvas px-3 py-2 text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
          />
        </label>

        <SchedulePicker />
      </div>

      <ScheduleAccuracyNote />

      {error ? (
        <p role="alert" className="mt-3 rounded-md bg-alert-soft px-3 py-2 text-sm text-alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:bg-brand-deep disabled:opacity-60"
        >
          {pending ? (
            <>
              <Spinner /> Saving…
            </>
          ) : (
            'Save search'
          )}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink hover:border-line-strong"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
