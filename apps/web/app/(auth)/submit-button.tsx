'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Spinner } from '../../components/spinner';
import styles from './auth.module.css';

/**
 * The submit button for every auth form, and the only client component on
 * these four pages.
 *
 * ## The problem it solves is not only that the wait looked like nothing
 *
 * These forms post to a server action that calls Supabase. That is a round
 * trip to Seoul — measured between 0.3s and 0.9s on a good connection, and
 * 5.5s when the first attempt has to be retried. For every one of those
 * seconds the page was completely inert: the button stayed lit, the label
 * stayed "Sign in", nothing moved. It reads as a dead screen, which is what
 * was reported.
 *
 * The part that is a bug rather than a feeling: the button also stayed
 * ENABLED. Nothing stopped a second press, and a second press is a second
 * `signInWithPassword`. Supabase rate-limits its token endpoint per IP, so
 * impatient double-pressing on a slow connection is a way to manufacture
 * the `over_request_rate_limit` failure — the site teaching you to break it
 * by not telling you it was listening. `disabled={pending}` is the actual
 * fix; the spinner is how somebody knows why it is disabled.
 *
 * ## Why `useFormStatus` and not `useTransition`
 *
 * `useTransition` would mean an `onSubmit` handler, which means the page
 * owns the submission, which means these pages stop being plain forms.
 * `useFormStatus` reads the status of the form this button is already
 * inside, so the markup does not change and `<form action={serverAction}>`
 * stays exactly what it was. It only works from INSIDE the form — a button
 * rendered by the same component as the `<form>` always reads `false` — and
 * that is why this is its own file rather than a few lines on each page.
 *
 * ## Without JavaScript it still works
 *
 * If this has not hydrated, `pending` never becomes true and the button is
 * an ordinary submit inside an ordinary form: the browser posts it natively
 * and shows its own tab spinner, exactly as it did before. The enhancement
 * is additive, which is the property the rest of these pages were built for.
 */
export function SubmitButton({
  children,
  pendingLabel,
}: {
  children: ReactNode;
  /**
   * Said out loud, so it names the action rather than the state. "Signing
   * in…" tells somebody what is happening; a bare spinner with the old
   * label tells them the press might not have registered.
   */
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      className={styles.submit}
      disabled={pending}
      /* The wait, for anything that is listening rather than looking. */
      aria-busy={pending}
    >
      {pending ? (
        <>
          <Spinner />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}
