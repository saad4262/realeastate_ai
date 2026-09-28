import type { Metadata } from 'next';
import Link from 'next/link';
import { setPasswordAction } from '../actions';
import { MIN_PASSWORD } from '../constants';
import styles from '../auth.module.css';

export const metadata: Metadata = {
  title: 'Set a new password — Property Platform',
  robots: { index: false, follow: false },
};

const ERRORS: Record<string, string> = {
  short_password: `Use at least ${MIN_PASSWORD} characters.`,
  weak_password: 'Choose a stronger password.',
  failed: 'That link may have expired. Ask for a new one and try again.',
};

/**
 * Reached only from the emailed link.
 *
 * `handleAuthCallback` has already traded the code for a session by the
 * time anybody gets here, so the authorisation is that session and
 * `updateUser` refuses on its own without one. There is no token in this
 * page and nothing for it to verify.
 */
export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const error = params.error ? (ERRORS[params.error] ?? ERRORS.failed) : null;

  return (
    <div className={styles.card}>
      <p className={styles.eyebrow}>Password</p>
      <h1 className={styles.title}>Set a new password</h1>
      <p className={styles.subtitle}>Choose something you have not used elsewhere.</p>

      {error ? (
        <p role="alert" className={styles.alert}>
          <span aria-hidden>!</span>
          <span>{error}</span>
        </p>
      ) : null}

      <form action={setPasswordAction} className={styles.form}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="password">
            New password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            autoFocus
            placeholder="••••••••"
            className={styles.input}
          />
          <span className={styles.hint}>At least {MIN_PASSWORD} characters.</span>
        </div>

        <button type="submit" className={styles.submit}>
          Save new password
        </button>
      </form>

      <div className={styles.meta}>
        <Link href="/forgot" className={styles.link}>
          Send me another link
        </Link>
      </div>
    </div>
  );
}
