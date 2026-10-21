import Link from 'next/link';
import { membershipRolePhrase } from '@repo/core/permissions';
import { AdminTabs } from '@/components/admin/tabs';
import styles from '@/components/admin/admin.module.css';
import { requirePlatformView } from '@/lib/require-platform-admin';

/**
 * One member of an agency in the admin console (ADR 0049): everything below
 * is what THIS person sees — their leads, inbox, calendar, team conversations
 * and assistant chats — read-only.
 */
export default async function MemberLayout({
  params,
  children,
}: {
  params: Promise<{ agencyId: string; userId: string }>;
  children: React.ReactNode;
}) {
  const { agencyId, userId } = await params;
  const view = await requirePlatformView(agencyId, userId);
  const subject = view.subject!;
  const base = `/agencies/${agencyId}/agents/${userId}`;
  return (
    <div className={styles.wrap}>
      <div className={styles.profileHead}>
        <div className={styles.avatarLg} aria-hidden>{subject.name.slice(0, 2).toUpperCase()}</div>
        <div className={styles.headText}>
          <h2 className={styles.title} style={{ fontSize: '1.25rem' }}>{subject.name}</h2>
          <p className={styles.sub}>
            {subject.email} · {membershipRolePhrase(subject.role).replace(/^(the|an?) /, '')}
            {subject.status !== 'active' ? <> · <span className={styles.badgeWarn}>{subject.status}</span></> : null}
          </p>
        </div>
        <Link className={styles.btn} href={`/emails?kind=member&agencyId=${agencyId}&userId=${userId}`} style={{ marginLeft: 'auto' }}>
          Send email
        </Link>
      </div>
      <AdminTabs
        label="Member"
        items={[
          { href: base, label: 'Overview' },
          { href: `${base}/leads`, label: 'Leads' },
          { href: `${base}/customers`, label: 'Customers' },
          { href: `${base}/inbox`, label: 'Inbox' },
          { href: `${base}/emails`, label: 'Email activity' },
          { href: `${base}/meetings`, label: 'Meetings' },
          { href: `${base}/listings`, label: 'Listings' },
          { href: `${base}/messages`, label: 'Team messages' },
          { href: `${base}/chats`, label: 'Assistant chats' },
          { href: `${base}/workflows`, label: 'Workflows' },
        ]}
      />
      {children}
    </div>
  );
}
