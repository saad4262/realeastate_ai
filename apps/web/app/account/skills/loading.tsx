import { WebShell } from '../../../components/web-shell';
import { Bar } from '../../../components/skeletons';
import styles from '../account.module.css';

/**
 * § 10 — the Skills page with its text removed, card for card: the back link, the title and its line,
 * then group cards of rows that each end in a switch. Signed in by construction: middleware already
 * sent anyone without a session away from /account.
 */
export default function SkillsLoading() {
  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page} aria-busy="true" aria-label="Loading your skills">
        <div className="mb-2" aria-hidden>
          <Bar w="7rem" h="0.875rem" />
        </div>
        <div aria-hidden>
          <Bar w="12rem" h="1.875rem" />
        </div>
        <div className={`${styles.body} mt-2`} aria-hidden>
          <Bar w="95%" h="0.9375rem" />
          <div className="mt-2">
            <Bar w="70%" h="0.9375rem" />
          </div>
        </div>
        {[2, 1, 2].map((rows, i) => (
          <section key={i} className={styles.card} aria-hidden>
            <div className={styles.cardLabel}>
              <Bar w="6rem" h="0.6875rem" />
            </div>
            {Array.from({ length: rows }, (_, j) => (
              <div key={j} className="flex items-start justify-between gap-4 py-3 first:pt-0">
                <div className="w-full">
                  <Bar w="9rem" h="1rem" />
                  <div className="mt-2">
                    <Bar w="85%" h="0.875rem" />
                  </div>
                </div>
                <span className="inline-block h-6 w-11 flex-none overflow-hidden rounded-full">
                  <Bar w="100%" h="100%" />
                </span>
              </div>
            ))}
          </section>
        ))}
      </main>
    </WebShell>
  );
}
