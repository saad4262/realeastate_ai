import type { Metadata } from 'next';
import Link from 'next/link';
import { requestResetAction } from '../actions';
import styles from '../auth.module.css';

export const metadata: Metadata = {
  title: 'Reset your password — Property Platform',
  robots: { index: false, follow: false },
};

export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const params = await searchParams;

  /**
   * Shown whether or not the address has an account.
   *
   * "No account with that email" on a public form is an enumeration
   * oracle. Somebody who mistyped finds out the same way they would
   * anywhere else: nothing arrives.
   */
  if (params.sent === '1') {
    return (
      <div className={styles.card}>
        <div className={styles.sentIcon} aria-hidden>
          ✉︎
        </div>
        <h1 className={styles.title}>Check your email</h1>
        <p className={styles.subtitle}>
          If there is an account with that address, a link to set a new password is on its way.
        </p>
        <p className={styles.below}>
          <Link href="/login" className={styles.link}>
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <p className={styles.eyebrow}>Password</p>
      <h1 className={styles.title}>Reset your password</h1>
      <p className={styles.subtitle}>
        Give us the address on your account and we will email you a link to set a new one.
      </p>

      {params.error ? (
        <p role="alert" className={styles.alert}>
          <span aria-hidden>!</span>
          <span>That does not look like an email address.</span>
        </p>
      ) : null}

      <form action={requestResetAction} className={styles.form}>
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
            placeholder="you@example.com"
            className={styles.input}
          />
        </div>

        <button type="submit" className={styles.submit}>
          Email me a reset link
        </button>
      </form>

      <div className={styles.meta}>
        <Link href="/login" className={styles.link}>
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
