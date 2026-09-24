'use client';

import { useState, type FormEvent } from 'react';
import { createBrowserSupabaseClient } from '@repo/auth/client';
import { syncAccountAction } from '../account-actions';
import styles from '../auth.module.css';

export function LoginForm({
  nextPath,
  inviteToken = null,
  initialEmail = '',
  agentHome,
  emailLabel,
}: {
  nextPath: string;
  /** Present when an invited agent already had an account and signed in to claim. */
  inviteToken?: string | null;
  initialEmail?: string;
  /** Absolute URL of the agent surface, for an invite claimed on this sign-in. */
  agentHome: string;
  /** "Agency email" on the agency host, "Your email" on the agent desk. */
  emailLabel: string;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createBrowserSupabaseClient();
    const { error: signError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signError) {
      setError(signError.message);
      setLoading(false);
      return;
    }

    // Past this point the session exists and the cookies are set. Whatever
    // happens next, this form must not be where the user ends up — leaving a
    // signed-in person staring at a sign-in box is the worst of both states.
    let destination = nextPath || '/';

    try {
      // Identity is re-read from the session server-side — never passed from here.
      const sync = await syncAccountAction({ inviteToken });

      if (sync.ok) {
        if (!sync.hasMembership && sync.inviteExpired) {
          setError(
            'Your agent invite has expired. Ask your agency to send a new one from Agents & Team, then sign in again.',
          );
          setLoading(false);
          return;
        }
        if (!sync.hasMembership) {
          destination = '/get-started';
        } else if (sync.claimed) {
          // Claiming here means this account just became an agent — send them
          // to the agent host rather than back to wherever the link was opened.
          destination = agentHome;
        }
      }
      // sync.ok === false only means the profile mirror did not run. The
      // session is real, so the destination's own requireConsoleAccess is a
      // better judge of where this account belongs than this form is.
    } catch {
      // A failed server action (usually a stale bundle mid-edit) used to land
      // in the outer catch and strand the user here. Navigate regardless.
    }

    window.location.href = destination;
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.field}>
        <label htmlFor="agency-email">{emailLabel}</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>mail</span>
          </span>
          <input
            id="agency-email"
            className={styles.input}
            type="email"
            autoComplete="email"
            required
            placeholder="name@agency.com.au"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label htmlFor="agency-password">Password</label>
          <a className={styles.forgot} href="/reset">
            Forgot password?
          </a>
        </div>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>lock</span>
          </span>
          <input
            id="agency-password"
            className={`${styles.input} ${styles.inputWithToggle}`}
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            placeholder="••••••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            className={styles.togglePwd}
            title={showPassword ? 'Hide password' : 'Show password'}
            onClick={() => setShowPassword((v) => !v)}
          >
            <span className={styles.glyph}>{showPassword ? 'visibility_off' : 'visibility'}</span>
          </button>
        </div>
      </div>

      <label className={styles.remember}>
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        />
        Remember me
      </label>

      {error ? <p className={styles.error}>{error}</p> : null}

      <button className={styles.submit} type="submit" disabled={loading}>
        <span>{loading ? 'Signing in…' : 'Sign In'}</span>
        {!loading ? <span className={styles.glyph}>arrow_forward</span> : null}
      </button>
    </form>
  );
}
