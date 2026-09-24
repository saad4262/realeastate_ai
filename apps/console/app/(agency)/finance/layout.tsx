import { redirect } from 'next/navigation';
import { can } from '@repo/core/permissions';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/** Finance & Trust — owner|admin via can(agency:billing). */
export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requireConsoleAccess('agency');
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
