import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthShell } from '../auth-shell';
import { getAuthAccount } from '../../../lib/auth-account';
import { loadActor } from '../../../lib/load-actor';
import { RegisterAgencyForm } from './register-agency-form';
import { removedFromAgency } from '@repo/core/team';
import { getConsoleDb } from '../../../lib/db';

export const metadata: Metadata = {
  title: 'Register your agency — LocalAgentHub OS',
};

/**
 * Landing spot for a signed-in account with no membership yet.
 * Invited agents never reach it — their claim runs at sign-in.
 */
export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  /**
   * Removed from an agency (ADR 0030 §5.5): say so, plainly, instead of a
   * sign-up form. "Register a different agency" stays one deliberate click away.
   */
  const removed = await removedFromAgency(getConsoleDb(), account.userId);
  const sp = await searchParams;
  if (removed && sp.register !== '1') {
    return (
      <AuthShell
        title="You no longer have access"
        subtitle={`Signed in as ${account.email}.`}
        footer={
          <>
            <Link href="/sign-out">Sign out</Link> · <Link href="/get-started?register=1">Register a different agency instead</Link>
          </>
        }
      >
        <p role="status" style={{ margin: 0, lineHeight: 1.6 }}>
          You no longer have access to <strong>{removed.agencyName}</strong>. An owner or admin removed you on{' '}
          {removed.removedAt.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}. If this
          was a mistake, ask them — a removal can be undone for 30 days. Your connected Google and Zoom accounts were
          disconnected and would need connecting again.
        </p>
      </AuthShell>
    );
  }

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
