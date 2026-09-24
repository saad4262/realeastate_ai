'use client';

import Link from 'next/link';
import styles from './failure.module.css';

/**
 * The body of every console error boundary.
 *
 * One component so the agency console and the agent desk cannot drift into two
 * different-looking failures; each route group's error.tsx supplies only where
 * "back" should go, because the two surfaces have different homes.
 *
 * Note what this deliberately does NOT catch: redirect(). requireConsoleAccess
 * signs a visitor out by throwing a redirect, and Next resolves that during the
 * server render rather than handing it to a boundary — so "not signed in" still
 * reaches /login instead of turning into "something went wrong". `pnpm smoke`
 * asserts that a protected route still answers 307/302 to /login.
 */
export function ConsoleError({
  error,
  reset,
  homeHref,
  homeLabel,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  homeHref: string;
  homeLabel: string;
}) {
  return (
    <div className={styles.wrap} role="alert">
      <span className={styles.icon} aria-hidden>
        error
      </span>
      <h1 className={styles.title}>This page didn’t load</h1>
      <p className={styles.body}>
        Something failed while building this screen. Nothing you were working on has
        been changed — retrying is safe.
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={reset}>
          Try again
        </button>
        <Link href={homeHref} className={styles.secondary}>
          {homeLabel}
        </Link>
      </div>
      {/*
        The real message only in development. In production Next replaces it
        with a digest, and a console error can carry a connection string or a
        row the viewer has no right to see.
      */}
      {process.env.NODE_ENV === 'development' ? (
        <p className={styles.digest}>{error.message}</p>
      ) : error.digest ? (
        <p className={styles.digest}>Reference: {error.digest}</p>
      ) : null}
    </div>
  );
}
