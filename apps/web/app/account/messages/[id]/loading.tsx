import { WebShell } from '../../../../components/web-shell';
import { Bar } from '../../../../components/skeletons';
import styles from '../messages.module.css';

/** One conversation's shape: back link, subject, agency, two bubbles (§ 10). */
export default function ConversationLoading() {
  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page} aria-busy="true" aria-label="Loading the conversation">
        <span className={styles.back} aria-hidden>
          <Bar w="7rem" h="0.875rem" />
        </span>
        <Bar w="70%" h="1.875rem" />
        <p className={styles.sub} aria-hidden>
          <Bar w="10rem" h="0.9375rem" />
        </p>
        <div className={styles.thread} aria-hidden>
          <div className={`${styles.msg} ${styles.mine}`}>
            <Bar w="18rem" h="4.5rem" />
          </div>
          <div className={`${styles.msg} ${styles.theirs}`}>
            <Bar w="20rem" h="6rem" />
          </div>
        </div>
      </main>
    </WebShell>
  );
}
