import { WebShell } from '../../../components/web-shell';
import { Bar } from '../../../components/skeletons';
import styles from '../account.module.css';

/** § 10 — the shortlist with its text removed: back link, title, line, then rows of photo + text. */
export default function ShortlistLoading() {
  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page} aria-busy="true" aria-label="Loading your shortlist">
        <Bar w="7rem" h="0.875rem" />
        <div className="mt-2">
          <Bar w="11rem" h="1.875rem" />
        </div>
        <div className="mt-4 rounded-2xl border border-line bg-card" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="grid grid-cols-[6rem_1fr] gap-3 border-t border-line-subtle p-4 first:border-t-0">
              <Bar w="100%" h="4.4rem" />
              <div>
                <Bar w="70%" h="1rem" />
                <div className="mt-2">
                  <Bar w="40%" h="0.875rem" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </WebShell>
  );
}
