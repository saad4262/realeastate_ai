'use client';

import { useState } from 'react';
import { syncAccountAction } from '../account-actions';
import styles from '../auth.module.css';

/**
 * Shown when someone opens an invite link while already signed in.
 *
 * Without this the middleware sent them to the dashboard and the invite was
 * dropped, which looked like the link "did nothing". Two cases matter: the
 * session is the invited person (accept in one click), or it belongs to
 * somebody else — usually the owner testing their own link — in which case
 * the only honest move is to sign out first.
 */
export function ClaimInvitePanel({
  inviteToken,
  inviteEmail,
  agencyName,
  sessionEmail,
  agentHome,
  returnTo,
}: {
  inviteToken: string;
  inviteEmail: string;
  agencyName: string;
  sessionEmail: string;
  /** Absolute URL of the agent surface — an agent does not belong on agency.* */
  agentHome: string;
  returnTo: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sameAccount = sessionEmail.toLowerCase() === inviteEmail.toLowerCase();
  const switchHref = `/sign-out?next=${encodeURIComponent(returnTo)}`;

  async function accept() {
    setBusy(true);
    setError(null);

    const sync = await syncAccountAction({ inviteToken });
    if (!sync.ok) {
      setError(sync.error);
      setBusy(false);
      return;
    }
    if (!sync.hasMembership) {
      setError(
        sync.inviteExpired
          ? 'This invite link has expired. Ask the agency to send a new one from Agents & Team.'
          : 'This invite could not be claimed with the signed-in account.',
      );
      setBusy(false);
      return;
    }

    // Full page load, not router.push — the agent surface is a different host.
    window.location.href = agentHome;
  }

  if (!sameAccount) {
    return (
      <div className={styles.form}>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
          This invite is for <strong>{inviteEmail}</strong>, but you are signed in as{' '}
          <strong>{sessionEmail}</strong>. Sign out and open the link again to accept it.
        </p>
        <a className={styles.submit} href={switchHref}>
          <span>Sign out and accept as {inviteEmail}</span>
          <span className={styles.glyph}>logout</span>
        </a>
      </div>
    );
  }

  return (
    <div className={styles.form}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
        You are signed in as <strong>{sessionEmail}</strong>. Accepting adds you to{' '}
        <strong>{agencyName}</strong> and creates your agent profile.
      </p>

      {error ? <p className={styles.error}>{error}</p> : null}

      <button className={styles.submit} type="button" disabled={busy} onClick={() => void accept()}>
        <span>{busy ? 'Joining…' : `Join ${agencyName}`}</span>
        {!busy ? <span className={styles.glyph}>arrow_forward</span> : null}
      </button>

      <a className={styles.forgot} href={switchHref} style={{ textAlign: 'center' }}>
        Use a different account
      </a>
    </div>
  );
}
