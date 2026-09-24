import type { Metadata } from 'next';
import Link from 'next/link';
import { peekAgentInvite } from '@repo/core/team';
import { getAuthAccount } from '../../../lib/auth-account';
import { getConsoleDb } from '../../../lib/db';
import { surfaceCopy } from '../../../lib/surface';
import { AuthShell } from '../auth-shell';
import { ClaimInvitePanel } from './claim-invite-panel';
import { SignupForm } from './signup-form';
import styles from '../auth.module.css';

export const metadata: Metadata = {
  title: 'Sign Up — LocalAgentHub OS',
};

/** Where a claimed agent belongs — never the agency host they were sent from. */
function agentHome(): string {
  return `${process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://agents.lvh.me:3001'}/listings`;
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; invite?: string; email?: string }>;
}) {
  const params = await searchParams;
  const copy = await surfaceCopy();
  const nextPath = params.next && params.next.startsWith('/') ? params.next : '/';
  const inviteToken = params.invite?.trim() || null;

  // Keep the token on the sign-in link — an agent who already has an account
  // must be able to claim without being pushed through registration.
  const loginQuery = new URLSearchParams();
  if (nextPath !== '/') loginQuery.set('next', nextPath);
  if (inviteToken) loginQuery.set('invite', inviteToken);
  const loginHref = loginQuery.size ? `/login?${loginQuery}` : '/login';

  const invite = inviteToken ? await peekAgentInvite(getConsoleDb(), inviteToken) : null;
  const account = inviteToken ? await getAuthAccount() : null;

  // Only agencies self-register. Reaching /signup on the agent host without an
  // invite used to offer agency registration, which would have made the agent
  // the owner of a brand new agency instead of joining the one that hired them.
  if (!copy.selfRegisters && !inviteToken) {
    return (
      <AuthShell
        title={copy.signUpTitle}
        subtitle={copy.signUpSubtitle}
        footer={
          <>
            Already set up? <Link href="/login">Sign in</Link>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
          {copy.noAccountHint} The link takes you straight to setting your password — there is nothing
          to fill in here first.
        </p>
      </AuthShell>
    );
  }

  // An invite that has already been accepted is the opposite of an expired
  // one — the person is on the roster and just needs to sign in.
  if (invite?.state === 'accepted') {
    return (
      <AuthShell
        agencyName={invite.agencyName}
        title="You have already joined"
        subtitle={`Your account is active at ${invite.agencyName}.`}
        footer={
          <>
            Wrong account? <Link href="/sign-out">Sign out</Link>
          </>
        }
      >
        <p style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.6 }}>
          This invite was accepted, so the link has done its job. Sign in as{' '}
          <strong>{invite.email}</strong> to reach your dashboard.
        </p>
        <a className={styles.submit} href={`/login?invite=${encodeURIComponent(inviteToken!)}`}>
          <span>Sign in</span>
          <span className={styles.glyph}>arrow_forward</span>
        </a>
      </AuthShell>
    );
  }

  if (inviteToken && (!invite || invite.state !== 'live')) {
    const revoked = invite?.state === 'revoked';
    return (
      <AuthShell
        title={
          !invite
            ? 'Invite link not recognised'
            : revoked
              ? 'This invite was withdrawn'
              : 'This invite has expired'
        }
        subtitle={
          !invite
            ? 'The link may have been altered or the invite withdrawn.'
            : revoked
              ? 'The agency cancelled this invitation.'
              : 'Invite links are short-lived, so this one needs replacing.'
        }
        footer={
          <>
            Already have an account? <Link href="/login">Sign in</Link>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
          Ask your agency to send a new link from <strong>Agents &amp; Team</strong>. Nothing else
          is needed from you — the new link takes you straight back here.
        </p>
      </AuthShell>
    );
  }

  if (invite && account) {
    const returnTo = `/signup?invite=${encodeURIComponent(inviteToken!)}&email=${encodeURIComponent(invite.email)}`;
    return (
      <AuthShell
        agencyName={invite.agencyName}
        title="Accept agent invite"
        subtitle={`${invite.agencyName} has invited you to join their roster.`}
        footer={
          <>
            Not expecting this? <Link href="/sign-out">Sign out</Link>
          </>
        }
      >
        <ClaimInvitePanel
          inviteToken={inviteToken!}
          inviteEmail={invite.email}
          agencyName={invite.agencyName}
          sessionEmail={account.email}
          agentHome={agentHome()}
          returnTo={returnTo}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={invite ? 'Accept agent invite' : copy.signUpTitle}
      subtitle={
        invite
          ? `Create your password to join ${invite.agencyName}.`
          : copy.signUpSubtitle
      }
      footer={
        <>
          Already have an account? <Link href={loginHref}>Sign in</Link>
        </>
      }
    >
      {invite ? (
        <p className={styles.sessionMeta} style={{ marginBottom: 12 }}>
          Invited as <strong>{invite.email}</strong>
        </p>
      ) : null}
      <SignupForm
        nextPath={nextPath}
        initialEmail={invite?.email ?? ''}
        inviteToken={inviteToken}
        agentHome={agentHome()}
        loginHref={loginHref}
        emailLabel={copy.emailLabel}
      />
    </AuthShell>
  );
}
