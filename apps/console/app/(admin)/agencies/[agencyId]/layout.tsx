import Link from 'next/link';
import { StatusBadge } from '@/components/admin/tables';
import { AdminTabs } from '@/components/admin/tabs';
import styles from '@/components/admin/admin.module.css';
import { requirePlatformView } from '@/lib/require-platform-admin';

/**
 * One agency in the admin console (ADR 0049): who it is, that this is a
 * read-only view, and its tabs. The view is resolved here and again by each
 * page (cached per request), so a page never trusts the layout to have run.
 */
export default async function AgencyLayout({
  params,
  children,
}: {
  params: Promise<{ agencyId: string }>;
  children: React.ReactNode;
}) {
  const { agencyId } = await params;
  const view = await requirePlatformView(agencyId);
  const base = `/agencies/${agencyId}`;
  return (
    <div className={styles.wrap}>
      <div className={styles.crumbs}>
        <Link href="/agencies">Agencies</Link> <span aria-hidden>/</span> <span>{view.agencyName}</span>
      </div>
      <div className={styles.profileHead}>
        <div className={styles.avatarLg} aria-hidden>
          {view.agencyName
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((w) => w[0]?.toUpperCase())
            .join('')}
        </div>
        <div className={styles.headText}>
          <h1 className={styles.title}>{view.agencyName}</h1>
          <p className={styles.sub}>
            <StatusBadge status={view.agencyStatus} />
            {view.agencyPlan ? <> · plan: {view.agencyPlan}</> : null} · {view.agencyTimeZone}
          </p>
        </div>
      </div>
      <p className={styles.banner} role="note">
        Admin view. The agency’s data here is read-only; its status, plan, owner and members’ access are changed from
        Controls on the Overview. Every page you open and every change is recorded.
      </p>
      <AdminTabs
        label="Agency"
        items={[
          { href: base, label: 'Overview' },
          { href: `${base}/agents`, label: 'Agents' },
          { href: `${base}/leads`, label: 'Leads' },
          { href: `${base}/customers`, label: 'Customers' },
          { href: `${base}/inbox`, label: 'Inbox' },
          { href: `${base}/emails`, label: 'Email activity' },
          { href: `${base}/meetings`, label: 'Meetings' },
          { href: `${base}/listings`, label: 'Listings' },
          { href: `${base}/messages`, label: 'Team messages' },
          { href: `${base}/workflows`, label: 'Workflows' },
        ]}
      />
      {children}
    </div>
  );
}
