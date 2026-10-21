import { LocalTime } from '@repo/ui';
import { listAgencyPeople } from '@repo/core/platform';
import { MemberControls } from '@/components/admin/controls';
import { Stat } from '@/components/admin/tables';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformView } from '@/lib/require-platform-admin';

/** A member's overview: what they are carrying, from the same counts as the agency's people table. */
export default async function MemberOverviewPage({ params }: { params: Promise<{ agencyId: string; userId: string }> }) {
  const { agencyId, userId } = await params;
  const view = await requirePlatformView(agencyId, userId);
  await recordPlatformView(view.actor, 'member');
  const people = await listAgencyPeople(getConsoleDb(), view.admin, agencyId);
  const me = people.find((p) => p.userId === userId);
  if (!me) return <p className={styles.empty}>No figures for this member.</p>;

  return (
    <div className={styles.wrap}>
      <div className={styles.stats}>
        <Stat label="Open leads" value={me.openLeads} />
        <Stat label="Listings" value={me.listings} />
        <Stat label="Customers assigned" value={me.contacts} />
        <Stat label="Upcoming meetings" value={me.upcomingMeetings} />
      </div>
      <MemberControls agencyId={agencyId} userId={userId} name={me.name} status={me.status} removed={me.removed} />
      <section className={styles.card}>
        <div className={styles.cardBody}>
          <dl className={styles.facts}>
            <dt>Agency</dt><dd>{view.agencyName}</dd>
            <dt>Email</dt><dd>{me.email}</dd>
            <dt>Phone</dt><dd>{me.phone ?? '—'}</dd>
            <dt>Status</dt><dd>{me.status === 'suspended' ? (me.removed ? 'removed by the agency' : 'blocked by the platform') : me.status}</dd>
            <dt>Joined</dt><dd>{me.joinedAt ? <LocalTime iso={me.joinedAt.toISOString()} style="date" /> : '—'}</dd>
            <dt>Last used assistant</dt><dd>{me.lastAssistantAt ? <LocalTime iso={me.lastAssistantAt.toISOString()} /> : 'Never'}</dd>
          </dl>
        </div>
      </section>
    </div>
  );
}
