import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardError, getDashboardData } from '@repo/core/dashboards';
import { DashboardView } from '@/components/dashboards/dashboard-view';
import styles from '@/components/dashboards/dashboards.module.css';
import { getConsoleDb } from '../../../../lib/db';
import { requireConsoleAccess } from '../../../../lib/require-console-access';

export const dynamic = 'force-dynamic';

/**
 * One project, inside the agency console's chrome: the sidebar stays and only
 * this area changes. The same read and the same not-found rule as the
 * full-screen page (`/dashboards/[id]`), which is still one click away for a
 * board that is left up on a wall.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireConsoleAccess('agency');
  try {
    const data = await getDashboardData(getConsoleDb(), session.actor, id);
    return (
      <div>
        <nav className={styles.crumbs} aria-label="Project">
          <Link href="/projects">← Projects</Link>
          <Link href={`/dashboards/${id}`} target="_blank" rel="noopener" prefetch={false} aria-label="Full screen (opens in a new tab)">
            Full screen ↗
          </Link>
        </nav>
        <DashboardView initial={data} inboxPath="/inbox" embedded />
      </div>
    );
  } catch (err) {
    if (err instanceof DashboardError) notFound();
    throw err;
  }
}
