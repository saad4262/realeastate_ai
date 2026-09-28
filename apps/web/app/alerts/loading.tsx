/**
 * This route queries the database, so it has its own loader (§ 10) — and it
 * renders this page's shape rather than a spinner, so the transition is a
 * fill rather than a flash.
 */
import { WebShell } from '../../components/web-shell';
import styles from './alerts.module.css';

export default function Loading() {
  return (
    // Middleware has already turned anyone without a session away from
    // /alerts, so the header can be drawn in its signed-in state here and
    // will not change when the page itself arrives.
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
      <div className={styles.head}>
        <div className="h-8 w-40 animate-pulse rounded-md bg-sunken" />
        <div className="h-9 w-36 animate-pulse rounded-full bg-sunken" />
        <div className="h-4 w-72 animate-pulse rounded-md bg-sunken" />
      </div>

      <div className={styles.section}>
        <div className="h-3 w-32 animate-pulse rounded bg-sunken" />
        <div className={styles.list}>
          {[0, 1].map((i) => (
            <div key={i} className="rounded-2xl border border-line bg-card p-5">
              <div className="h-4 w-48 animate-pulse rounded bg-sunken" />
              <div className="mt-2 h-3 w-64 animate-pulse rounded bg-sunken" />
              <div className="mt-3 h-3 w-40 animate-pulse rounded bg-sunken" />
            </div>
          ))}
        </div>
      </div>
      </main>
    </WebShell>
  );
}
