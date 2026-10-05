import Link from 'next/link';
import { can } from '@repo/core/permissions';
import { listContactAssignees } from '@repo/core/contacts';
import { ContactForm } from '@/components/contacts/contact-form';
import styles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../../../lib/db';
import { requireConsoleAccess } from '../../../../lib/require-console-access';

/** Add a contact by hand. Whether this actor may, and may assign it, is can()'s. */
export default async function NewContactPage() {
  const session = await requireConsoleAccess('agency');
  const directory = { type: 'contact', agencyId: session.actor.agencyId };
  if (!can(session.actor, 'contact:create', directory)) {
    return (
      <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>
        You can view contacts but not add them.
      </p>
    );
  }
  const assignees = await listContactAssignees(getConsoleDb(), session.actor);
  return (
    <div className={styles.wrap}>
      <Link href="/customers" className={styles.back}>← All contacts</Link>
      <div className={styles.headText}>
        <h1 className={styles.title}>New contact</h1>
        <p className={styles.sub}>
          People who enquire, make an offer or email the agency are added automatically — use this for everyone else.
        </p>
      </div>
      <div className={styles.card}>
        <ContactForm mode="create" basePath="/customers" assignees={assignees} />
      </div>
    </div>
  );
}
