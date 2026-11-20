import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { safeLocalPath } from '@repo/auth/safe-path';
import { getAuthAccount } from '../../../lib/auth-account';
import { surfaceCopy } from '../../../lib/surface';
import { SignOutButton } from '@/components/sign-out-button';
import { AuthShell } from '../auth-shell';
import styles from '../auth.module.css';
import { MfaPanel } from './mfa-panel';

export const metadata: Metadata = { title: 'Security — LocalAgentHub OS', robots: { index: false, follow: false } };

/**
 * Sign-in security, on every surface (PLATFORM-PLAN 1.3, 1.22): two-step sign-in with an authenticator app, a new
 * password, and "Sign out of all devices". `?next=` is where a page sent the person to verify a code (team,
 * billing, admin changes) and where they go back to afterwards.
 */
export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const account = await getAuthAccount();
  if (!account) redirect('/login?next=/security');
  const params = await searchParams;
  const { home } = await surfaceCopy();
  const next = params.next ? safeLocalPath(params.next, home) : null;

  return (
    <AuthShell
      title={next ? 'Confirm it’s you' : 'Security'}
      subtitle={next ? 'Enter the code from your authenticator app to continue.' : `Signed in as ${account.email}.`}
      footer={<Link href={next ?? home}>{next ? 'Cancel' : 'Back to the console'}</Link>}
    >
      <MfaPanel next={next} />
      {next ? null : (
        <div className={styles.form} style={{ marginTop: '1.5rem' }}>
          <div className={styles.labelRow}>
            <strong>Password</strong>
            <Link className={styles.forgot} href="/reset/update">
              Change password
            </Link>
          </div>
          <p className={styles.note}>A new password signs you out on your other devices.</p>
          <SignOutButton scope="global" className={styles.submit}>
            <span>Sign out of all devices</span>
          </SignOutButton>
          <p className={styles.note}>Every browser and phone signed in to this account, this one included, has to sign in again.</p>
        </div>
      )}
    </AuthShell>
  );
}
