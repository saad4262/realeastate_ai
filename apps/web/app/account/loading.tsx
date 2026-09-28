import { WebShell } from '../../components/web-shell';
import styles from './account.module.css';

/**
 * § 10 — this route queries the database, so it declares what it is doing
 * instead of leaving the previous page on screen.
 *
 * `signedIn: true` is safe to assert here: middleware has already redirected
 * anyone without a session away from /account, so a skeleton for this route
 * is only ever rendered for somebody who has one.
 */
export default function AccountLoading() {
  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page} aria-busy="true">
        <header className={styles.head}>
          <span className={styles.avatar} aria-hidden />
          <div className={styles.identity}>
            <h1 className={styles.title}>Your account</h1>
            <p className={styles.email}>Loading…</p>
          </div>
        </header>
      </main>
    </WebShell>
  );
}
