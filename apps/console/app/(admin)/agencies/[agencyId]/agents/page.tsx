import { listAgencyPeople } from '@repo/core/platform';
import { PeopleTable } from '@/components/admin/tables';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformView } from '@/lib/require-platform-admin';

/** Everyone in the agency — removed members too — with what each carries. Click one to see what they see. */
export default async function AgencyAgentsPage({ params }: { params: Promise<{ agencyId: string }> }) {
  const { agencyId } = await params;
  const view = await requirePlatformView(agencyId);
  await recordPlatformView(view.actor, 'agents');
  const people = await listAgencyPeople(getConsoleDb(), view.admin, agencyId);
  return (
    <div className={styles.wrap}>
      <div className={styles.headText}>
        <h2 className={styles.h2}>Agents &amp; team ({people.length})</h2>
        <p className={styles.sub}>Open someone to see their leads, inbox, meetings, team messages and assistant chats as they see them.</p>
      </div>
      <section className={styles.card}>
        <PeopleTable rows={people} />
      </section>
    </div>
  );
}
