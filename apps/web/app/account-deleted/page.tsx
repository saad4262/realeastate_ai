import type { Metadata } from 'next';
import Link from 'next/link';
import { WebShell } from '../../components/web-shell';
import styles from '../account/account.module.css';

export const metadata: Metadata = { title: 'Account deleted', robots: { index: false, follow: false } };

/** Where deleting an account lands (PLATFORM-PLAN 5.12): signed out, nothing left to show. */
export default function AccountDeletedPage() {
  return (
    <WebShell account={{ signedIn: false }}>
      <main className={styles.page}>
        <h1 className={styles.title}>Your account has been deleted</h1>
        <p className={styles.body}>Your sign-in and everything saved to the account are gone. Thank you for using the site.</p>
        <p className={styles.body}>
          <Link href="/">Back to the home page</Link>
        </p>
      </main>
    </WebShell>
  );
}
