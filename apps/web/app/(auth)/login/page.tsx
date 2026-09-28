import type { Metadata } from 'next';
import Link from 'next/link';
import { signInAction } from '../actions';
import styles from '../auth.module.css';

export const metadata: Metadata = {
  title: 'Sign in — Property Platform',
  // Nothing here for a crawler, and an indexed auth page is a phishing
  // template somebody else gets to borrow.
  robots: { index: false, follow: false },
};

const ERRORS: Record<string, string> = {
  /**
   * One message for a wrong password and an unknown address, on purpose.
   * Telling them apart lets anybody check which addresses have accounts.
   */
  bad_credentials: 'That email and password do not match an account.',
  unconfirmed: 'Confirm your email first — check your inbox for the link we sent.',
  // From @repo/auth/callback: a stale or already-used link.
  auth_link: 'That link has expired or was already used. Sign in below instead.',
  failed: 'Something went wrong signing you in. Try again in a moment.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string }>;
}) {
  const params = await searchParams;
  const next =
    params.next && params.next.startsWith('/') && !params.next.startsWith('//')
      ? params.next
      : '/alerts';
  const error = params.error ? (ERRORS[params.error] ?? ERRORS.failed) : null;

  return (
    <div className={styles.card}>
      <p className={styles.eyebrow}>Welcome back</p>
      <h1 className={styles.title}>Sign in</h1>
      <p className={styles.subtitle}>
        Your saved searches, your alerts and everything you have asked the guide.
      </p>

      {error ? (
        <p role="alert" className={styles.alert}>
          <span aria-hidden>!</span>
          <span>{error}</span>
        </p>
      ) : null}

      <form action={signInAction} className={styles.form}>
        <input type="hidden" name="next" value={next} />

        <div className={styles.field}>
          <label className={styles.label} htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            defaultValue={params.email ?? ''}
            placeholder="you@example.com"
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="••••••••"
            className={styles.input}
          />
        </div>

        <button type="submit" className={styles.submit}>
          Sign in
        </button>
      </form>

      <div className={styles.meta}>
        <div className={styles.metaRow}>
          <span>
            New here?{' '}
            <Link href={`/signup?next=${encodeURIComponent(next)}`} className={styles.link}>
              Create an account
            </Link>
          </span>
          <Link href="/forgot" className={styles.link}>
            Forgot password?
          </Link>
        </div>
      </div>

      <p className={styles.below}>
        <Link href="/search" className={styles.link}>
          Keep browsing without an account
        </Link>
      </p>
    </div>
  );
}
