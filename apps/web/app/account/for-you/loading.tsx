import { WebShell } from '../../../components/web-shell';
import { Bar } from '../../../components/skeletons';
import styles from '../account.module.css';

/** § 10 — For you with its text removed: back link, title, line, then a grid of cards beside the profile card. */
export default function ForYouLoading() {
  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page} aria-busy="true" aria-label="Loading your suggestions">
        <Bar w="7rem" h="0.875rem" />
        <div className="mt-2">
          <Bar w="6rem" h="1.875rem" />
        </div>
        <div className="mt-2 mb-4">
          <Bar w="70%" h="0.9375rem" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <section key={i} className={styles.card} aria-hidden>
              <Bar w="50%" h="1rem" />
              <div className="mt-2">
                <Bar w="80%" h="0.875rem" />
              </div>
              <div className="mt-2">
                <Bar w="65%" h="0.75rem" />
              </div>
            </section>
          ))}
        </div>
      </main>
    </WebShell>
  );
}
