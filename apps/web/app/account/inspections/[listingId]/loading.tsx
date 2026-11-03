import { WebShell } from '../../../../components/web-shell';
import { Bar } from '../../../../components/skeletons';
import styles from '../../account.module.css';

/** § 10 — One notebook with its text removed: back link, title, the checklist card. */
export default function NotebookLoading() {
  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page} aria-busy="true" aria-label="Loading your notes for this home">
        <Bar w="7rem" h="0.875rem" />
        <div className="mt-2">
          <Bar w="9rem" h="1.875rem" />
        </div>
        <div className="mt-2 mb-4">
          <Bar w="80%" h="0.9375rem" />
        </div>
        {[2, 1].map((rows, i) => (
          <section key={i} className={styles.card} aria-hidden>
            <Bar w="60%" h="1rem" />
            {Array.from({ length: rows }, (_, j) => (
              <div key={j} className="mt-3">
                <Bar w="85%" h="0.875rem" />
              </div>
            ))}
          </section>
        ))}
      </main>
    </WebShell>
  );
}
