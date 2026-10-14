import { SkeletonBar } from '@/components/page-skeleton';
import styles from '@/components/dashboards/dashboards.module.css';

/** A project's shape while its figures are worked out: the crumbs, the header, a row of tiles. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className={styles.crumbs}>
        <SkeletonBar height="0.875rem" width="5rem" />
        <SkeletonBar height="0.875rem" width="5.5rem" />
      </div>
      <div className={styles.head}>
        <div style={{ display: 'grid', gap: '0.5rem', width: 'min(28rem, 100%)' }}>
          <SkeletonBar height="0.6875rem" width="4rem" />
          <SkeletonBar height="1.75rem" width="70%" />
          <SkeletonBar height="0.8125rem" width="90%" />
        </div>
      </div>
      <div className={styles.grid}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={styles.tile}>
            <SkeletonBar height="0.75rem" width="40%" />
            <div style={{ marginTop: '0.75rem' }}>
              <SkeletonBar height="2.25rem" width="55%" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
