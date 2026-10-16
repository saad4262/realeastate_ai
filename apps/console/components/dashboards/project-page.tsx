import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardError, getDashboardData } from '@repo/core/dashboards';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { DashboardView } from './dashboard-view';
import styles from './dashboards.module.css';

const PATHS = {
  agency: { list: '/projects', inbox: '/inbox' },
  agent: { list: '/my-projects', inbox: '/my-inbox' },
} as const;

/**
 * One project, inside the console's chrome (/projects/[id], /my-projects/[id]):
 * the sidebar stays and only this area changes. The same read and the same
 * not-found rule as the full-screen page (`/dashboards/[id]`), which is still
 * one click away for a board that is left up on a wall. Every figure is
 * computed as the viewer.
 */
export async function ProjectPage({ surface, id }: { surface: 'agency' | 'agent'; id: string }) {
  const session = await requireConsoleAccess(surface);
  const paths = PATHS[surface];
  try {
    const data = await getDashboardData(getConsoleDb(), session.actor, id);
    return (
      <div>
        <nav className={styles.crumbs} aria-label="Project">
          <Link href={paths.list}>← Projects</Link>
          <Link href={`/dashboards/${id}`} target="_blank" rel="noopener" prefetch={false} aria-label="Full screen (opens in a new tab)">
            Full screen ↗
          </Link>
        </nav>
        <DashboardView initial={data} inboxPath={paths.inbox} embedded />
      </div>
    );
  } catch (err) {
    if (err instanceof DashboardError) notFound();
    throw err;
  }
}
