import { WebShell } from '../../../components/web-shell';
import { Bar } from '../../../components/skeletons';
import styles from '../messages/messages.module.css';

/** The meetings page's own shape: back link, title, subtitle, rows (§ 10). */
export default function MeetingsLoading() {
  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page} aria-busy="true" aria-label="Loading your meetings">
        <span className={styles.back} aria-hidden>
          <Bar w="7rem" h="0.875rem" />
        </span>
        <Bar w="14rem" h="1.875rem" />
        <p className={styles.sub} aria-hidden>
          <Bar w="20rem" h="0.9375rem" />
        </p>
        <ul className={styles.list} aria-hidden>
          {[0, 1].map((i) => (
            <li key={i} className={styles.item}>
              <div className={styles.row}>
                <Bar w="50%" h="1rem" />
                <Bar w="70%" h="0.875rem" />
                <Bar w="6rem" h="1.75rem" />
              </div>
            </li>
          ))}
        </ul>
      </main>
    </WebShell>
  );
}
