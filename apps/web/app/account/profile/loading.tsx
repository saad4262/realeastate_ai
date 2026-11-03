import { WebShell } from '../../../components/web-shell';
import { Bar } from '../../../components/skeletons';
import styles from '../account.module.css';

/** § 10 — the profile with its text removed: back link, title, two lines, the facts card and the forget card. */
export default function ProfileLoading() {
  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page} aria-busy="true" aria-label="Loading your profile">
        <Bar w="7rem" h="0.875rem" />
        <div className="mt-2">
          <Bar w="14rem" h="1.875rem" />
        </div>
        <div className="mb-4 mt-2">
          <Bar w="90%" h="0.9375rem" />
        </div>
        <section className={styles.card} aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="mt-3 first:mt-0">
              <Bar w="70%" h="0.9375rem" />
            </div>
          ))}
        </section>
        <section className={styles.card} aria-hidden>
          <Bar w="40%" h="0.75rem" />
        </section>
      </main>
    </WebShell>
  );
}
