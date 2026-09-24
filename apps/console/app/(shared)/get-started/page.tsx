import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthShell } from '../auth-shell';
import { getAuthAccount } from '../../../lib/auth-account';
import { loadActor } from '../../../lib/load-actor';
import { RegisterAgencyForm } from './register-agency-form';

export const metadata: Metadata = {
  title: 'Register your agency — LocalAgentHub OS',
};

/**
 * Landing spot for a signed-in account with no membership yet.
 * Invited agents never reach it — their claim runs at sign-in.
 */
export default async function GetStartedPage() {
  const account = await getAuthAccount();
  if (!account) {
    redirect('/login?next=/get-started');
  }

  const actor = await loadActor(account.userId);
  if (actor === null) {
    redirect('/login?error=database');
  }
  if (actor.agencyId && actor.membershipRole) {
    redirect('/');
  }

  const agencyUrl = process.env.NEXT_PUBLIC_AGENCY_URL ?? 'http://agency.lvh.me:3001';

  return (
    <AuthShell
      title="Register your agency"
      subtitle={`Signed in as ${account.email}. Create the agency you will run — you become its licensee in charge.`}
      footer={
        <>
          Joined by invitation instead? <Link href="/sign-out">Sign out</Link> and use the invite
          link your agency sent you.
        </>
      }
    >
      <RegisterAgencyForm
        defaultOwnerName={account.name ?? ''}
        agencyUrl={agencyUrl}
      />
    </AuthShell>
  );
}
