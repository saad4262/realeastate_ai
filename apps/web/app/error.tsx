'use client';

import Link from 'next/link';
import { AppShell } from '@repo/ui';
import styles from './failure.module.css';

/**
 * What a visitor sees when a page throws.
 *
 * Before this existed there was nothing: an unhandled throw anywhere in the
 * consumer site produced a blank document. Several pages catch their own
 * database failures and carry on with `down: true` — this is for everything
 * nobody anticipated.
 *
 * Rendered inside AppShell on purpose. A bare error page reads as "the site is
 * gone"; one with the site's own header around it reads as "this page failed",
 * which is both true and less alarming.
 *
 * `reset()` re-renders the segment without a full reload, so a transient
 * database blip costs a click rather than a page load.
 */
export default function WebError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <AppShell surface="web">
      <div className={styles.wrap}>
        <h1 className={styles.title}>Something went wrong</h1>
        <p className={styles.body}>
          This page could not be loaded. Listings are unaffected — trying again usually
          works.
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={reset}>
            Try again
          </button>
          <Link href="/search" className={styles.secondary}>
            Back to search
          </Link>
        </div>
        {/*
          The message itself is only shown in development. In production Next
          replaces it with a generic string and a digest, and printing an
          internal error to a public page is how a connection string ends up in
          a screenshot.
        */}
        {process.env.NODE_ENV === 'development' ? (
          <p className={styles.digest}>{error.message}</p>
        ) : error.digest ? (
          <p className={styles.digest}>Reference: {error.digest}</p>
        ) : null}
      </div>
    </AppShell>
  );
}
