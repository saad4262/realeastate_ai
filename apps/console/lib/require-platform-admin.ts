import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import type { Actor } from '@repo/core/permissions';
import { loadPlatformAdmin, logPlatformView, platformViewActor, PlatformError, type PlatformView } from '@repo/core/platform';
import { getConsoleDb } from './db';
import { requireConsoleSession } from './require-console-access';

export type PlatformAdminSession = { admin: Actor; userLabel: string };

/**
 * The admin console's gate (ADR 0049): the session middleware verified, and a
 * row in `platform_admin` for it. Anyone else — an agency owner included — is
 * sent to sign in with "no access". Cached per request so the layout and the
 * page ask once.
 */
export const requirePlatformAdmin = cache(async (): Promise<PlatformAdminSession> => {
  const session = await requireConsoleSession();
  let admin: Actor | null;
  try {
    admin = await loadPlatformAdmin(getConsoleDb(), session.userId);
  } catch {
    redirect('/login?error=database');
  }
  if (!admin) redirect('/login?error=forbidden');
  return { admin, userLabel: session.label };
});

/**
 * A read-only view of one agency, or of one member of it, for a page under
 * /agencies/[agencyId]. Records the page in the view log before it renders a
 * thing. Not found (404) for an agency or member that is not there.
 */
export const requirePlatformView = cache(
  async (agencyId: string, userId?: string): Promise<PlatformView & { admin: Actor }> => {
    const { admin } = await requirePlatformAdmin();
    try {
      const view = await platformViewActor(getConsoleDb(), admin, { agencyId, ...(userId ? { userId } : {}) });
      return { ...view, admin };
    } catch (err) {
      if (err instanceof PlatformError && err.code === 'not_found') notFound();
      throw err;
    }
  },
);

/**
 * Record one admin page, before its data is read. Fails closed: the user's
 * rule is that every read is recorded, so a page whose log row could not be
 * written does not render (it errors) rather than reading unrecorded.
 */
export async function recordPlatformView(who: Actor, area: string, refId?: string | null, subjectUserId?: string | null): Promise<void> {
  await logPlatformView(getConsoleDb(), who, { area, refId: refId ?? null, subjectUserId: subjectUserId ?? null });
}
