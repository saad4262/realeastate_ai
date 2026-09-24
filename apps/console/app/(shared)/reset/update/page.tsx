import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthAccount } from '../../../../lib/auth-account';
import { AuthShell } from '../../auth-shell';
import { UpdatePasswordForm } from './update-password-form';

export const metadata: Metadata = {
  title: 'Set a New Password — LocalAgentHub OS',
};

export default async function UpdatePasswordPage() {
  // The recovery link creates a real session at /auth/callback before landing
  // here, so no session means the link was stale, already used, or opened in
  // a different browser than the one that asked for it.
  const account = await getAuthAccount();

  if (!account) {
    redirect('/reset?error=link_expired');
  }

  return (
    <AuthShell
      title="Set a new password"
      subtitle={`You are signing in as ${account.email}.`}
      footer={
        <>
          Changed your mind? <Link href="/sign-out">Sign out</Link>
        </>
      }
    >
      <UpdatePasswordForm email={account.email} />
    </AuthShell>
  );
}
