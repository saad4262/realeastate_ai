'use client';

import { useState, type FormEvent } from 'react';
import { createBrowserSupabaseClient } from '@repo/auth/client';
import { syncAccountAction } from '../account-actions';
import styles from '../auth.module.css';

export function SignupForm({
  nextPath,
  initialEmail = '',
  inviteToken = null,
  agentHome,
  loginHref,
  emailLabel,
}: {
  nextPath: string;
  initialEmail?: string;
  inviteToken?: string | null;
  /** Absolute URL of the agent surface, for invited agents after they claim. */
  agentHome: string;
  loginHref: string;
  /** "Agency email" on the agency host, "Your email" on the agent desk. */
  emailLabel: string;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const origin = window.location.origin;
      const { data, error: signError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: fullName ? { full_name: fullName, name: fullName } : undefined,
          // Same one-time-code trade as password recovery — /auth/callback
          // has to run before any page can see a session.
          emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
        },
      });
      if (signError) {
        // Supabase answers "User already registered" here. With an invite in
        // hand that is not a dead end — signing in claims it just as well.
        const exists = /already\s*registered|already\s*exists/i.test(signError.message);
        setError(
          exists && inviteToken
            ? 'An account with this email already exists. Sign in instead and the invite is applied automatically.'
            : signError.message,
        );
        setLoading(false);
        return;
      }

      // No session yet means Supabase is set to confirm emails first.
      if (!data.session) {
        setMessage(
          inviteToken
            ? 'Check your email to confirm. After confirming and signing in, your agency invite activates.'
            : 'Check your email to confirm your account, then sign in.',
        );
        setLoading(false);
        return;
      }

      // Mirrors public.user and claims an invite for this session's email only.
      const sync = await syncAccountAction({ inviteToken });
      if (!sync.ok) {
        setError(sync.error);
        setLoading(false);
        return;
      }

      // A lapsed invite must not fall through to "register your own agency".
      if (!sync.hasMembership && sync.inviteExpired) {
        setError(
          'This invite link has expired. Ask your agency to send a new one from Agents & Team — your account is created, so signing in again once they do is enough.',
        );
        setLoading(false);
        return;
      }

      // Invited agents belong on the agent host, not the agency host the link
      // was sent from; everyone else registers an agency of their own.
      window.location.href = sync.hasMembership
        ? sync.claimed
          ? agentHome
          : nextPath || '/'
        : '/get-started';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-up failed');
      setLoading(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.field}>
        <label htmlFor="signup-name">Your Name</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>person</span>
          </span>
          <input
            id="signup-name"
            className={styles.input}
            type="text"
            autoComplete="name"
            required
            placeholder="Jane Doe"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor="signup-email">{emailLabel}</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>mail</span>
          </span>
          <input
            id="signup-email"
            className={styles.input}
            type="email"
            autoComplete="email"
            required
            placeholder="name@agency.com.au"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly={Boolean(initialEmail && inviteToken)}
          />
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor="signup-password">Password</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>lock</span>
          </span>
          <input
            id="signup-password"
            className={`${styles.input} ${styles.inputWithToggle}`}
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            minLength={8}
            placeholder="At least 8 characters"
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

      {inviteToken ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
          You are accepting an agency agent invite. Your membership and agent profile are created
          when you sign up with this email.
        </p>
      ) : null}

      {error ? (
        <p className={styles.error}>
          {error}
          {inviteToken && /already exists/i.test(error) ? (
            <>
              {' '}
              <a href={loginHref}>Sign in</a>
            </>
          ) : null}
        </p>
      ) : null}
      {message ? <p className={styles.success}>{message}</p> : null}

      <button className={styles.submit} type="submit" disabled={loading}>
        <span>{loading ? 'Creating account…' : 'Sign Up'}</span>
        {!loading ? <span className={styles.glyph}>arrow_forward</span> : null}
      </button>
    </form>
  );
}
