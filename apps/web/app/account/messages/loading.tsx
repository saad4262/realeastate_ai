import { WebShell } from '../../../components/web-shell';
import { Bar } from '../../../components/skeletons';
import styles from './messages.module.css';

/** The messages list's own shape: back link, title, subtitle, rows (§ 10). */
export default function MessagesLoading() {
  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page} aria-busy="true" aria-label="Loading your messages">
        <span className={styles.back} aria-hidden>
          <Bar w="7rem" h="0.875rem" />
        </span>
        <Bar w="9rem" h="1.875rem" />
        <p className={styles.sub} aria-hidden>
          <Bar w="18rem" h="0.9375rem" />
        </p>
        <ul className={styles.list} aria-hidden>
          {[0, 1, 2].map((i) => (
            <li key={i} className={styles.item}>
              <div className={styles.row}>
                <Bar w="40%" h="1rem" />
                <Bar w="75%" h="0.875rem" />
                <Bar w="90%" h="0.8125rem" />
              </div>
            </li>
          ))}
        </ul>
      </main>
    </WebShell>
  );
}
