import { redirect } from 'next/navigation';
import { can } from '@repo/core/permissions';
import { requireConsoleAccess } from '../../../lib/require-console-access';

/** Team directory — owner|admin via can(team:manage). */
export default async function TeamLayout({ children }: { children: React.ReactNode }) {
  const { actor } = await requireConsoleAccess('agency');
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
