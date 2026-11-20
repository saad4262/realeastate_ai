import type { Metadata } from 'next';
import Link from 'next/link';
import { WebShell } from '../../../components/web-shell';
import { requireWebUser } from '../../../lib/session';
import styles from '../account.module.css';
import { DeleteAccountForm } from './delete-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Delete your account', robots: { index: false, follow: false } };

/** PLATFORM-PLAN 5.12: what deleting removes, what stays with agencies, and the confirmation. */
export default async function DeleteAccountPage() {
  const user = await requireWebUser('/account/delete');
  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <header className={styles.head}>
          <div className={styles.identity}>
            <h1 className={styles.title}>Delete your account</h1>
            <p className={styles.email}>{user.email}</p>
          </div>
        </header>
        <section className={styles.card}>
          <h2 className={styles.cardLabel}>What is removed, straight away</h2>
          <p className={styles.body}>
            Your sign-in, your shortlist and notes, homes you follow, saved searches and alerts, inspection notes and photos,
            conversations with the property guide, your Personal Property AI profile, tasks and automations. This cannot be undone.
          </p>
        </section>
        <section className={styles.card}>
          <h2 className={styles.cardLabel}>What stays with an agency</h2>
          <p className={styles.body}>
            An enquiry or offer you sent an agency is that agency’s record of your contact with them, and stays with them, no
            longer linked to an account. To have it removed, ask the agency.
          </p>
        </section>
        <section className={styles.card}>
          <h2 className={styles.cardLabel}>Delete</h2>
          <DeleteAccountForm email={user.email ?? ''} />
        </section>
        <p className={styles.body}>
          <Link href="/account" className={styles.secondary}>Keep my account</Link>
        </p>
      </main>
    </WebShell>
  );
}
