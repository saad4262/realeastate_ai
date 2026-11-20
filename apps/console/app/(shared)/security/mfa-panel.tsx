'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { createBrowserSupabaseClient } from '@repo/auth/client';
import styles from '../auth.module.css';

type State =
  | { step: 'loading' }
  | { step: 'none' }
  | { step: 'enrol'; factorId: string; qr: string; secret: string }
  | { step: 'verify'; factorId: string }
  | { step: 'on'; factorId: string; since: string };

/**
 * Two-step sign-in with an authenticator app (Supabase TOTP; PLATFORM-PLAN 1.3). Supabase holds the factor; this
 * only drives its flow. A verified code upgrades the session to `aal2`, which middleware signs into the identity
 * header and can() reads. `next` set: a page asked for a fresh code (team, billing, platform changes); after it,
 * a full navigation there, so middleware sees the new session.
 */
export function MfaPanel({ next }: { next: string | null }) {
  const [state, setState] = useState<State>({ step: 'loading' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const supabase = createBrowserSupabaseClient();
    const [{ data: factors }, { data: aal }] = await Promise.all([supabase.auth.mfa.listFactors(), supabase.auth.mfa.getAuthenticatorAssuranceLevel()]);
    const totp = factors?.totp[0];
    if (!totp) return setState({ step: 'none' });
    // A code is asked when the session has none yet, or when a page sent the person here for a fresh one.
    if (next || aal?.currentLevel !== 'aal2') return setState({ step: 'verify', factorId: totp.id });
    setState({ step: 'on', factorId: totp.id, since: new Date(totp.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) });
  }

  useEffect(() => {
    load().catch(() => setError('Could not reach the sign-in service. Reload to try again.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  async function startEnrol() {
    setBusy(true);
    setError(null);
    const supabase = createBrowserSupabaseClient();
    // A set-up abandoned half-way leaves an unverified factor; Supabase refuses a second one with the same name.
    const { data: factors } = await supabase.auth.mfa.listFactors();
    for (const f of factors?.all ?? []) if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
    const { data, error: e } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator app' });
    setBusy(false);
    if (e || !data) return setError(e?.message ?? 'Could not start the set-up.');
    setState({ step: 'enrol', factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (state.step !== 'enrol' && state.step !== 'verify') return;
    setBusy(true);
    setError(null);
    const supabase = createBrowserSupabaseClient();
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId: state.factorId, code: code.trim() });
    if (err) {
      setBusy(false);
      return setError('That code did not work. Check the time on your phone and try the newest code.');
    }
    if (next) {
      window.location.href = next;
      return;
    }
    setBusy(false);
    setCode('');
    await load();
  }

  async function remove() {
    if (state.step !== 'on' || !window.confirm('Turn off two-step sign-in? Owners and admins need it for team and billing pages.')) return;
    setBusy(true);
    const supabase = createBrowserSupabaseClient();
    const { error: err } = await supabase.auth.mfa.unenroll({ factorId: state.factorId });
    setBusy(false);
    if (err) return setError(err.message);
    await load();
  }

  const codeForm = (label: string) => (
    <form className={styles.form} onSubmit={submitCode}>
      <div className={styles.field}>
        <label htmlFor="mfa-code">{label}</label>
        <input
          id="mfa-code"
          className={styles.input}
          style={{ paddingLeft: '0.875rem', letterSpacing: '0.2em' }}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          placeholder="123456"
          value={code}
          onChange={(ev) => setCode(ev.target.value.replace(/\D/g, ''))}
        />
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <button className={styles.submit} type="submit" disabled={busy || code.length !== 6}>
        <span>{busy ? 'Checking…' : 'Verify'}</span>
      </button>
    </form>
  );

  return (
    <section aria-labelledby="mfa-heading" className={styles.form}>
      <div className={styles.labelRow}>
        <strong id="mfa-heading">Two-step sign-in</strong>
      </div>
      {state.step === 'loading' ? <p className={styles.note}>Checking…</p> : null}
      {state.step === 'none' ? (
        <>
          <p className={styles.note}>
            Sign in with your password and a code from an authenticator app (Google Authenticator, 1Password, Microsoft
            Authenticator). Owners and admins need it for the team and billing pages.
          </p>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <button className={styles.submit} type="button" onClick={startEnrol} disabled={busy}>
            <span>{busy ? 'Starting…' : 'Set up an authenticator app'}</span>
          </button>
        </>
      ) : null}
      {state.step === 'enrol' ? (
        <>
          <p className={styles.note}>Scan this with your authenticator app, then enter the 6-digit code it shows.</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- Supabase returns the QR code as an SVG data URL */}
          <img className={styles.qr} src={state.qr} alt="QR code for your authenticator app" />
          <p className={styles.note}>
            Can’t scan? Enter this key instead: <span className={styles.secret}>{state.secret}</span>
          </p>
          {codeForm('Code from the app')}
        </>
      ) : null}
      {state.step === 'verify' ? codeForm('6-digit code') : null}
      {state.step === 'on' ? (
        <>
          <p className={styles.note}>On, with an authenticator app, since {state.since}.</p>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <button className={styles.secondary} type="button" onClick={remove} disabled={busy}>
            Turn off
          </button>
        </>
      ) : null}
      <p className={styles.note}>
        Lost your phone? Ask another owner or admin of your agency to contact support. Support checks it is you and
        removes the old app, and you set it up again.
      </p>
    </section>
  );
}
