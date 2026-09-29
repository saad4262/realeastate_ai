import type { Metadata } from 'next';
import Link from 'next/link';
import { signUpAction } from '../actions';
import { SubmitButton } from '../submit-button';
import { MIN_PASSWORD } from '../constants';
import styles from '../auth.module.css';

export const metadata: Metadata = {
  title: 'Create an account — Property Platform',
  robots: { index: false, follow: false },
};

const ERRORS: Record<string, string> = {
  no_name: 'Tell us what to call you.',
  bad_email: 'That does not look like an email address.',
  short_password: `Use at least ${MIN_PASSWORD} characters.`,
  weak_password: 'Choose a stronger password.',
  /**
   * This one is a deliberate leak, and the smaller of two evils.
   *
   * Signup cannot hide that an address is taken — the account either gets
   * created or it does not — so pretending otherwise would just strand
   * somebody who already has one. Sign-in is where the enumeration matters
   * and that is where the answer is uniform.
   */
  already_registered: 'There is already an account with that email. Sign in instead.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  unavailable: 'We could not reach the sign-up service. Check your connection and try again.',
  signup_disabled: 'New accounts are not being accepted right now.',
  failed: 'Something went wrong. Try again in a moment.',
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; sent?: string; name?: string; email?: string }>;
}) {
  const params = await searchParams;
  const next =
    params.next && params.next.startsWith('/') && !params.next.startsWith('//')
      ? params.next
      : '/alerts';
  const error = params.error ? (ERRORS[params.error] ?? ERRORS.failed) : null;

  /**
   * Only reached when the Supabase project has "Confirm email" on, in which
   * case signUp returns no session and the account is not usable yet. The
   * page branches on what actually came back rather than assuming a setting.
   */
  if (params.sent === '1') {
    return (
      <div className={styles.card}>
        <div className={styles.sentIcon} aria-hidden>
          ✉︎
        </div>
        <h1 className={styles.title}>Confirm your email</h1>
        <p className={styles.subtitle}>
          We have sent you a link. Open it and your account is ready — you will not need to do
          this again.
        </p>
        <p className={styles.notice}>
          <span aria-hidden>·</span>
          <span>It can take a minute, and it sometimes lands in spam.</span>
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
      <p className={styles.eyebrow}>Free · takes a minute</p>
      <h1 className={styles.title}>Create your account</h1>
      <p className={styles.subtitle}>
        Save a search and the guide will run it for you, and send you only what is new.
      </p>

      {error ? (
        <p role="alert" className={styles.alert}>
          <span aria-hidden>!</span>
          <span>{error}</span>
        </p>
      ) : null}

      <form action={signUpAction} className={styles.form}>
        <input type="hidden" name="next" value={next} />

        <div className={styles.field}>
          <label className={styles.label} htmlFor="name">
            Your name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            required
            maxLength={120}
            autoFocus
            defaultValue={params.name ?? ''}
            placeholder="Alex Taylor"
            className={styles.input}
          />
        </div>

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
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            placeholder="••••••••"
            className={styles.input}
          />
          {/* Said before it is broken, not as an error afterwards. */}
          <span className={styles.hint}>At least {MIN_PASSWORD} characters.</span>
        </div>

        <SubmitButton pendingLabel="Creating your account…">Create account</SubmitButton>
      </form>

      <p className={styles.fine}>
        We use your address to sign you in and to send the alerts you ask for, and for nothing
        else. Every alert email has a one-click unsubscribe, and you can delete your saved
        searches and conversations at any time.
      </p>

      <div className={styles.meta}>
        Already have an account?{' '}
        <Link href={`/login?next=${encodeURIComponent(next)}`} className={styles.link}>
          Sign in
        </Link>
      </div>
    </div>
  );
}
