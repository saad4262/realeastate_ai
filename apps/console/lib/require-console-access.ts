import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { can, type Actor, type MembershipRole } from '@repo/core/permissions';
import { loadActorContext } from './load-actor';

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: 'Licensee in Charge',
  admin: 'Agency Admin',
  agent: 'Agent',
  assistant: 'Assistant',
  property_manager: 'Property Manager',
  read_only: 'Read only',
};

export type ConsoleSession = {
  userId: string;
  userLabel: string;
  userRole: string;
  /** The signed-in account's agency, for chrome. Null only before onboarding. */
  agencyName: string | null;
  /** Live counts for the header — every one of them from SQL. */
  summary: { members: number; liveListings: number; pendingInvites: number };
  actor: Actor;
};

/**
 * AuthN via Supabase getUser + AuthZ via can()/loadActor for the host surface.
 * Cached per request so nested layouts/pages can reuse without double getUser.
 */
/**
 * The session, as middleware verified it.
 *
 * Middleware already calls getUser() on every request and forwards the result
 * as headers it clears first, so calling getUser() again here was a second
 * round trip to the auth service for an answer we already had — measured at
 * ~520 ms on every single page load, before any of the page's own work.
 *
 * Absent header means either middleware found nobody or the request did not
 * pass through it. Both are treated as "not signed in", so this fails closed.
 */
async function sessionFromMiddleware() {
  const h = await headers();
  const userId = h.get('x-console-user-id');
  if (!userId) return null;

  const decode = (value: string | null) => {
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  };

  return {
    userId,
    email: decode(h.get('x-console-user-email')),
    label: decode(h.get('x-console-user-label')),
  };
}

/** The chrome's own data. Never a permission input — those stay in can(). */
export type ConsoleChrome = {
  userRole: string;
  agencyName: string | null;
  summary: { members: number; liveListings: number; pendingInvites: number };
};

const CHROME_FALLBACK: ConsoleChrome = {
  userRole: 'Member',
  agencyName: null,
  summary: { members: 0, liveListings: 0, pendingInvites: 0 },
};

/**
 * Who the request is, from middleware's headers alone.
 *
 * No database, no auth service — just the headers middleware already set after
 * verifying the session, so this returns in microseconds. The layout uses it to
 * paint the shell immediately; authorisation is a separate, slower question
 * answered by requireConsoleAccess below, under its own Suspense boundary.
 *
 * Signed out still fails closed: no header means no session, and we redirect.
 */
export async function requireConsoleSession(): Promise<{ userId: string; label: string }> {
  const session = await sessionFromMiddleware();
  if (!session) {
    redirect('/login');
  }
  return {
    userId: session.userId,
    label: session.label || session.email?.split('@')[0] || 'User',
  };
}

/**
 * Agency name, role and header counts — everything the chrome shows and
 * nothing it decides with.
 *
 * Resolves a round trip after the shell has already painted, so it must never
 * reject: a throw here would blank the chrome over a decorative count.
 */
export async function loadConsoleChrome(userId: string): Promise<ConsoleChrome> {
  try {
    const context = await loadActorContext(userId);
    if (!context) return CHROME_FALLBACK;
    const role = context.actor.membershipRole;
    return {
      userRole: role ? ROLE_LABELS[role] : 'Member',
      agencyName: context.agencyName,
      summary: context.summary,
    };
  } catch {
    return CHROME_FALLBACK;
  }
}

export const requireConsoleAccess = cache(
  async (surface: 'agency' | 'agent'): Promise<ConsoleSession> => {
    const session = await sessionFromMiddleware();
    if (!session) {
      redirect('/login');
    }

    const context = await loadActorContext(session.userId);
    const actor = context?.actor ?? null;

    if (actor === null) {
      redirect('/login?error=database');
    }

    // Signed in but not in any agency yet — send them to register one (ADR 0006),
    // rather than bouncing to a login page they are already past.
    if (!actor.agencyId || !actor.membershipRole) {
      redirect('/get-started');
    }

    const action = surface === 'agency' ? 'console:agency' : 'console:agent';
    if (!can(actor, action, { type: 'console', agencyId: actor.agencyId })) {
      if (surface === 'agency') {
        const agentUrl = process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://agents.lvh.me:3001';
        redirect(`${agentUrl}/listings`);
      }
      redirect('/login?error=forbidden');
    }

    const userLabel =
      session.label || context?.userName || session.email?.split('@')[0] || 'User';
    const userRole = actor.membershipRole
      ? ROLE_LABELS[actor.membershipRole]
      : 'Member';

    return {
      userId: session.userId,
      userLabel,
      userRole,
      agencyName: context?.agencyName ?? null,
      summary: context?.summary ?? { members: 0, liveListings: 0, pendingInvites: 0 },
      actor,
    };
  },
);
