import Link from 'next/link';
import { AUDIENCE_LABELS, listDashboards } from '@repo/core/dashboards';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { ArchiveDashboardButton } from './archive-button';
import styles from './dashboards.module.css';

/**
 * The dashboards this person may open (ADR 0027). Saved by owners/admins through
 * the assistant's card; opened by signed-in members of the agency only.
 */
export async function DashboardsPage({ surface }: { surface: 'agency' | 'agent' }) {
  const session = await requireConsoleAccess(surface);
  const rows = await listDashboards(getConsoleDb(), session.actor);
  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.head}>
        <div className={contactStyles.headText}>
          <h1 className={contactStyles.title}>Dashboards</h1>
          <p className={contactStyles.sub}>
            Live figures that refresh about every minute. {surface === 'agency'
              ? 'To make one, ask the assistant — for example “make a dashboard with sold value and new leads this week” — and approve its card.'
              : 'Owners and admins make these; you see the ones shared with the whole agency, each figure as far as you may see it.'}
          </p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className={styles.muted}>No dashboards yet.</p>
      ) : (
        <div className={styles.list}>
          {rows.map((d) => (
            <div key={d.id} className={styles.listRow}>
              <div>
                {/*
                  A dashboard opens in its own tab.

                  It is a thing you leave up — on a second screen, on the wall
                  — and it refreshes itself about every minute. Replacing the
                  console with it meant going Back to do anything else, which
                  closed the dashboard you had just opened.

                  The arrow is not decoration: a link that steals a new tab
                  with no warning is the small rudeness this marks. Screen
                  readers get the same fact in words, because they cannot see
                  the arrow.
                */}
                <Link href={`/dashboards/${d.id}`} target="_blank" rel="noopener">
                  {d.title}
                  <span className={styles.newTab} aria-hidden>
                    ↗
                  </span>
                  <span className="sr-only">(opens in a new tab)</span>
                </Link>
                <div className={styles.sub}>
                  {d.widgetCount} widget{d.widgetCount === 1 ? '' : 's'} · {AUDIENCE_LABELS[d.audience]}
                </div>
              </div>
              {d.mayManage ? <ArchiveDashboardButton id={d.id} /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
