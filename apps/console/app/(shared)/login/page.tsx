import type { Metadata } from 'next';
import Link from 'next/link';
import { peekAgentInvite } from '@repo/core/team';
import { getConsoleDb } from '../../../lib/db';
import { surfaceCopy } from '../../../lib/surface';
import { AuthShell } from '../auth-shell';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign In — LocalAgentHub OS',
};

const ERROR_MESSAGES: Record<string, string> = {
  forbidden: 'Your account does not have access to this console.',
  database:
    'Database is not configured (check DATABASE_URL). Membership checks cannot run.',
  auth_link:
    'That email link could not be used — it may have expired or already been opened. Request a new one.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string;
    error?: string;
    invite?: string;
    reason?: string;
  }>;
}) {
  const params = await searchParams;
  const inviteToken = params.invite?.trim() || null;
  // An agent who already has an account claims by signing in, so the invite
  // has to survive the hop from /signup to here.
  const invite = inviteToken ? await peekAgentInvite(getConsoleDb(), inviteToken) : null;
  const agentHome = `${process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://agents.lvh.me:3001'}/listings`;
  const liveInvite = invite?.state === 'live' ? invite : null;
  // Hardcoding /overview sent every agent to the agency console first and
  // relied on a refusal there to bounce them back to their own surface.
  const copy = await surfaceCopy();
  const home = copy.home;
  const nextPath = params.next && params.next.startsWith('/') ? params.next : home;
  const signupHref =
    nextPath !== home ? `/signup?next=${encodeURIComponent(nextPath)}` : '/signup';
  const bannerError =
    params.error && ERROR_MESSAGES[params.error]
      ? ERROR_MESSAGES[params.error]
      : null;
  // Supabase's own wording, kept alongside ours rather than swallowed.
  const bannerReason = bannerError && params.reason ? params.reason : null;

  return (
    <AuthShell
      agencyName={liveInvite?.agencyName ?? null}
      title={liveInvite ? 'Sign in to accept your invite' : copy.signInTitle}
      subtitle={
        liveInvite
          ? `Signing in as ${liveInvite.email} adds you to ${liveInvite.agencyName}.`
          : copy.signInSubtitle
      }
      footer={
        <>
          {copy.selfRegisters ? (
            <>
              Don&apos;t have an account? <Link href={signupHref}>{copy.noAccountHint}</Link>
            </>
          ) : (
            copy.noAccountHint
          )}
        </>
      }
    >
      {bannerError ? (
        <p
          role="alert"
          style={{
            margin: '0 0 1rem',
            padding: '0.75rem 1rem',
            borderRadius: 8,
            background: 'color-mix(in srgb, #c62828 12%, transparent)',
            color: '#b71c1c',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {bannerError}
          {bannerReason ? (
            <span style={{ display: 'block', marginTop: 4, fontWeight: 400, opacity: 0.85 }}>
              {bannerReason}
            </span>
          ) : null}
        </p>
      ) : null}
      <LoginForm
        nextPath={nextPath}
        inviteToken={liveInvite ? inviteToken : null}
        initialEmail={liveInvite?.email ?? ''}
        agentHome={agentHome}
        emailLabel={copy.emailLabel}
      />
    </AuthShell>
  );
}
