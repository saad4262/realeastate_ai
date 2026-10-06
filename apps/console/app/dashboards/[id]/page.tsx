import { notFound } from 'next/navigation';
import { DashboardError, getDashboardData } from '@repo/core/dashboards';
import { DashboardView } from '@/components/dashboards/dashboard-view';
import { getConsoleDb } from '../../../lib/db';
import { requireConsoleAccess } from '../../../lib/require-console-access';

export const dynamic = 'force-dynamic';

/**
 * A dashboard by link (ADR 0027): outside both consoles' chrome so it fills a
 * TV, on either host. Signed in, a member of the same agency, and its audience
 * — anyone else gets a plain not-found, so a guessed or forwarded link opens
 * nothing. Every figure is computed as the viewer.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // `agent` is the gate every active member passes (owners and admins included).
  const session = await requireConsoleAccess('agent');
  try {
    const data = await getDashboardData(getConsoleDb(), session.actor, id);
    return <DashboardView initial={data} />;
  } catch (err) {
    if (err instanceof DashboardError) notFound();
    throw err;
  }
}
