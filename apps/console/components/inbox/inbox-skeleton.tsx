import { SkeletonBar } from '../page-skeleton';
import styles from './inbox.module.css';

/**
 * The inbox's own shape — heading, folders, the conversation list — built from
 * inbox.module.css so the skeleton cannot drift from the page it stands in for
 * (ARCHITECTURE § 10). Used by both /inbox and /my-inbox.
 */
export function InboxSkeleton() {
  return (
    <div className={styles.wrap} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className={styles.head}>
        <div style={{ display: 'grid', gap: '0.5rem', width: '100%', maxWidth: '32rem' }}>
          <SkeletonBar height="1.8rem" width="8rem" />
          <SkeletonBar height="0.9rem" />
        </div>
      </div>
      <div className={styles.folders}>
        {[4.5, 5, 8].map((w) => (
          <SkeletonBar key={w} height="2.1rem" width={`${w}rem`} radius="999px" />
        ))}
      </div>
      <div className={styles.card}>
        <ul className={styles.list}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className={styles.item}>
              <div className={styles.row}>
                <span className={styles.noDot} />
                <SkeletonBar height="0.9rem" width="70%" />
                <SkeletonBar height="0.9rem" />
                <SkeletonBar height="0.75rem" width="3rem" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
