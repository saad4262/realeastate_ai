import { SkeletonBar } from '@/components/page-skeleton';
import contactStyles from '@/components/contacts/contacts.module.css';
import styles from '@/components/dashboards/dashboards.module.css';

/** The Projects grid's shape, out of the grid's own classes (ARCHITECTURE.md § 10). */
export default function Loading() {
  return (
    <div className={contactStyles.wrap} aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className={contactStyles.headText}>
        <SkeletonBar height="1.75rem" width="9rem" />
        <SkeletonBar height="0.875rem" width="min(36rem, 90%)" />
      </div>
      <ul className={styles.cards}>
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className={styles.card}>
            <div className={styles.thumb} />
            <div className={styles.cardBody}>
              <SkeletonBar height="1.75rem" width="1.75rem" radius="0.375rem" />
              <div className={styles.cardText}>
                <SkeletonBar height="0.875rem" width="70%" />
                <div style={{ marginTop: '0.375rem' }}>
                  <SkeletonBar height="0.75rem" width="50%" />
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
