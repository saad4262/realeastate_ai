'use client';

import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { createBrowserSupabaseClient } from '@repo/auth/client';
import { AuthShell } from '../auth-shell';
import styles from '../auth.module.css';

export function ResetPasswordScreen({ subtitle }: { subtitle: string }) {
  const linkExpired = useSearchParams().get('error') === 'link_expired';
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'email' | 'key'>('email');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const origin = window.location.origin;
      // Straight to /login the one-time code was never exchanged, so the
      // link signed nobody in and there was nowhere to set a password.
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent('/reset/update')}`,
      });
      if (resetError) {
        setError(resetError.message);
        setLoading(false);
        return;
      }
      setSent(true);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Reset Access & Statutory Account Recovery"
      subtitle={subtitle}
      footer={
        <>
          Remembered it? <Link href="/login">Back to Sign In</Link>
        </>
      }
    >
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <button
          type="button"
          className={tab === 'email' ? styles.submit : undefined}
          style={
            tab !== 'email'
              ? {
                  flex: 1,
                  height: 40,
                  borderRadius: 8,
                  border: '1px solid var(--border-default)',
                  background: 'var(--surface-canvas)',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: 13,
                }
              : { flex: 1 }
          }
          onClick={() => setTab('email')}
        >
          Corporate Email
        </button>
        <button
          type="button"
          style={{
            flex: 1,
            height: 40,
            borderRadius: 8,
            border: '1px solid var(--border-default)',
            background: tab === 'key' ? 'var(--sapphire-subtle)' : 'var(--surface-canvas)',
            color: tab === 'key' ? 'var(--sapphire)' : 'var(--text-secondary)',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 13,
          }}
          onClick={() => setTab('key')}
        >
          YubiKey / Biometrics
        </button>
      </div>

      {linkExpired ? (
        <p className={styles.error} role="alert">
          That recovery link has expired or was already used. Send yourself a new one.
        </p>
      ) : null}

      {tab === 'email' ? (
        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.field}>
            <label htmlFor="reset-email">Email</label>
            <div className={styles.inputWrap}>
              <span className={styles.inputIcon} aria-hidden>
                <span className={styles.glyph}>mail</span>
              </span>
              <input
                id="reset-email"
                className={styles.input}
                type="email"
                required
                autoComplete="email"
                placeholder="name@agency.com.au"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>
          {error ? <p className={styles.error}>{error}</p> : null}
          {sent ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--emerald)' }}>
              If an account exists for that email, a recovery link has been sent.
            </p>
          ) : null}
          <button type="submit" className={styles.submit} disabled={loading || sent}>
            {loading ? 'Sending…' : 'Send recovery link'}
            {!loading ? <span className={styles.glyph}>arrow_forward</span> : null}
          </button>
        </form>
      ) : (
        <div className={styles.form}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
            Hardware / biometric recovery is not enabled yet. Use corporate email reset.
          </p>
          <button type="button" className={styles.submit} disabled>
            <span className={styles.glyph}>fingerprint</span>
            Coming soon
          </button>
        </div>
      )}
    </AuthShell>
  );
}
