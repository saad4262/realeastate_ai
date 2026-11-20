import { redirect } from 'next/navigation';
import { can, refusedForMfa } from '@repo/core/permissions';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/** Finance & Trust — owner|admin via can(agency:billing). */
export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requireConsoleAccess('agency');
  // PLATFORM-PLAN 1.3: refused only for want of a recent second factor → verify it, then come back here.
  if (refusedForMfa(actor, 'agency:billing', { type: 'agency', agencyId: actor.agencyId })) redirect('/security?next=/finance');
  if (
    !can(actor, 'agency:billing', {
      type: 'agency',
      agencyId: actor.agencyId,
    })
  ) {
    redirect('/overview');
  }
  return children;
}
