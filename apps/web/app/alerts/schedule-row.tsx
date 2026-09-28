'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { deleteScheduleAction, setScheduleStatusAction, updateScheduleAction } from './actions';
import {
  ScheduleAccuracyNote,
  SchedulePicker,
  type ScheduleDefaults,
} from '../../components/schedule-picker';

/**
 * One saved search, with its controls.
 *
 * A client component because pause/resume/delete want to stay put rather
 * than navigate, and delete is two clicks. Everything it decides is a
 * display decision — the server refuses regardless, and `can()` is what
 * actually says who may touch this row. Hiding a button is a courtesy (§ 9).
 *
 * It takes `nextRunAt` as a string rather than a Date: props cross the
 * server/client boundary as JSON, and a Date that arrives as a string while
 * the type still says Date is the bug ARCHITECTURE § 6 names by class. The
 * string is the honest type here.
 */
export function ScheduleRow({
  id,
  name,
  description,
  searchPath,
  status,
  cadence,
  nextRunAt,
  failures,
  timing,
}: {
  id: string;
  name: string;
  description: string;
  searchPath: string;
  status: 'active' | 'paused' | 'failing';
  /** Already rendered by core's describeCadence. Display only. */
  cadence: string;
  nextRunAt: string;
  failures: number;
  /**
   * The raw fields, so the edit form opens showing what is actually set.
   *
   * Separate from `cadence` on purpose: that is a sentence for a human and
   * this is the state of the row. Deriving the form's values by parsing the
   * sentence would be the same mistake ADR 0010 is about, two layers down.
   */
  timing: ScheduleDefaults;
}) {
  const [pending, startTransition] = useTransition();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? 'That did not work.');
    });
  }

  const next = new Date(nextRunAt);
  // Name is often the same sentence as the filters written out — show one.
  const detail =
    description.trim().toLowerCase() === name.trim().toLowerCase() ? null : description;

  return (
    <li className="rounded-2xl border border-line bg-card p-5 shadow-[0_1px_2px_rgba(11,61,46,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold leading-snug tracking-tight text-ink">{name}</p>
          {detail ? <p className="mt-1 text-sm leading-relaxed text-ink-soft">{detail}</p> : null}
        </div>

        <span
          className={
            status === 'active'
              ? 'shrink-0 rounded-full bg-success-soft px-2.5 py-1 text-xs font-semibold text-success'
              : status === 'failing'
                ? 'shrink-0 rounded-full bg-alert-soft px-2.5 py-1 text-xs font-semibold text-alert'
                : 'shrink-0 rounded-full bg-sunken px-2.5 py-1 text-xs font-semibold text-ink-soft'
          }
        >
          {status === 'active' ? 'On' : status === 'failing' ? 'Needs attention' : 'Off'}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-sunken px-3 py-1 text-xs font-semibold text-ink">{cadence}</span>
        {status === 'active' ? (
          <span className="rounded-full border border-line bg-raised px-3 py-1 text-xs text-ink-soft">
            Next{' '}
            <time
              dateTime={nextRunAt}
              className="font-semibold tabular-nums text-ink"
              suppressHydrationWarning
            >
              {next.toLocaleString('en-AU', {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </time>
          </span>
        ) : null}
      </div>

      {/*
        `failing` and `paused` are different states and are shown differently.
        One is a decision the person made; the other is the system giving up
        after three consecutive errors, and saying "Off" for that would
        hide a broken alert behind something that looks deliberate.
      */}
      {status === 'failing' ? (
        <p className="mt-3 rounded-md bg-alert-soft px-3 py-2 text-sm text-alert">
          This search failed {failures} times in a row and has stopped. Turning it back on will
          try again.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 rounded-md bg-alert-soft px-3 py-2 text-sm text-alert">
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => act(() => setScheduleStatusAction(id, status === 'active' ? 'paused' : 'active'))}
          className={
            status === 'active'
              ? 'rounded-full bg-ink px-4 py-2 text-sm font-semibold text-canvas hover:bg-brand-deep disabled:opacity-60'
              : 'rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:bg-brand-deep disabled:opacity-60'
          }
        >
          {status === 'active' ? 'Turn off' : 'Turn on'}
        </button>

        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            setEditing((was) => !was);
          }}
          aria-expanded={editing}
          className="rounded-full border border-line bg-card px-4 py-2 text-sm font-semibold text-ink hover:border-line-strong disabled:opacity-60"
        >
          {editing ? 'Close' : 'Edit'}
        </button>

        <Link
          href={searchPath}
          className="rounded-full border border-line bg-card px-4 py-2 text-sm font-semibold text-ink hover:border-line-strong"
        >
          View results
        </Link>

        {confirmingDelete ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => act(() => deleteScheduleAction(id))}
              className="rounded-full bg-alert px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {pending ? 'Deleting…' : 'Delete'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded-full border border-line bg-card px-3 py-2 text-sm font-semibold text-ink-soft hover:text-ink"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="rounded-full border border-line bg-card px-3 py-2 text-sm font-semibold text-ink-soft hover:border-alert hover:text-alert"
          >
            Delete
          </button>
        )}
      </div>

      {/*
        The edit form, inline, using the same picker as "save a new search".

        One component for both, because two would drift: a second copy of
        `describeCadence` living in this page is exactly how an hourly
        schedule came to be labelled "Every day at 12:00 AM", and a picker
        duplicated for editing would go the same way silently.

        `key` on the form remounts it when the panel is reopened, so the
        selects come back showing what is stored rather than whatever was
        half-typed and abandoned last time.
      */}
      {editing ? (
        <form
          key={`${id}-edit`}
          action={(formData) => {
            setError(null);
            startTransition(async () => {
              const result = await updateScheduleAction(formData);
              if (result.ok) setEditing(false);
              else setError(result.error ?? 'That did not work.');
            });
          }}
          className="mt-4 rounded-2xl border border-line bg-canvas p-4"
        >
          <input type="hidden" name="scheduleId" value={id} />

          <p className="text-sm font-medium text-ink">Change when this runs</p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-ink-soft">Name it</span>
              <input
                name="name"
                maxLength={120}
                defaultValue={name}
                className="mt-1 w-full rounded-xl border border-line bg-card px-3 py-2 text-ink focus:border-brand focus:outline-none"
              />
            </label>

            <SchedulePicker defaults={timing} />
          </div>

          <ScheduleAccuracyNote />

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:bg-brand-deep disabled:opacity-60"
            >
              {pending ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-full border border-line bg-card px-4 py-2 text-sm font-semibold text-ink hover:border-line-strong"
            >
              Cancel
            </button>
            {/*
              Said here because it is the one surprising consequence of an
              edit: changing the timing re-anchors the cursor, so the next
              run is counted from now rather than from whenever it would
              have been.
            */}
            {status === 'active' ? (
              <span className="text-xs text-ink-faint">
                Saving moves the next run to the next matching time.
              </span>
            ) : (
              <span className="text-xs text-ink-faint">
                This search is off. Saving changes the time; it stays off.
              </span>
            )}
          </div>
        </form>
      ) : null}
    </li>
  );
}
