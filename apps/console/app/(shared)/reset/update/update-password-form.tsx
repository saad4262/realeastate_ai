'use client';

import { useState, type FormEvent } from 'react';
import { createBrowserSupabaseClient } from '@repo/auth/client';
import styles from '../../auth.module.css';

export function UpdatePasswordForm({ email }: { email: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();

    // Checked here so a mismatch never costs a round trip.
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match');
      return;
    }

    setLoading(true);
    setError(null);

    const supabase = createBrowserSupabaseClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    setDone(true);
    // The recovery session is already a full session, so there is nowhere to
    // sign in again — send them straight to where they were headed.
    window.setTimeout(() => {
      window.location.href = '/';
    }, 1200);
  }

  if (done) {
    return (
      <p className={styles.success}>
        Password updated for {email}. Taking you to your dashboard…
      </p>
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.field}>
        <label htmlFor="new-password">New password</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>lock</span>
          </span>
          <input
            id="new-password"
            className={`${styles.input} ${styles.inputWithToggle}`}
            type={show ? 'text' : 'password'}
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
            title={show ? 'Hide password' : 'Show password'}
            onClick={() => setShow((v) => !v)}
          >
            <span className={styles.glyph}>{show ? 'visibility_off' : 'visibility'}</span>
          </button>
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor="confirm-password">Confirm new password</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>lock_reset</span>
          </span>
          <input
            id="confirm-password"
            className={styles.input}
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            required
            minLength={8}
            placeholder="Type it again"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      <button className={styles.submit} type="submit" disabled={loading}>
        <span>{loading ? 'Saving…' : 'Save new password'}</span>
        {!loading ? <span className={styles.glyph}>arrow_forward</span> : null}
      </button>
    </form>
  );
}
