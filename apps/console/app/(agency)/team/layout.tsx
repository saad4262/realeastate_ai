import { redirect } from 'next/navigation';
import { can, refusedForMfa } from '@repo/core/permissions';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/** Team directory — owner|admin via can(team:manage). */
export default async function TeamLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requireConsoleAccess('agency');
  // PLATFORM-PLAN 1.3: refused only for want of a recent second factor → verify it, then come back here.
  if (refusedForMfa(actor, 'team:manage', { type: 'team', agencyId: actor.agencyId })) redirect('/security?next=/team');
  if (
    !can(actor, 'team:manage', {
      type: 'team',
      agencyId: actor.agencyId,
    })
  ) {
    redirect('/overview');
  }
  return children;
}
