import { SkeletonBar } from '@/components/page-skeleton';
import styles from '@/components/assistant/assistant-home.module.css';

/** The home's shape — greeting over composer — so arriving here is a fill, not a flash of another page. */
export default function Loading() {
  return (
    <div className={styles.home} data-full-bleed aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className={styles.stage}>
        <div style={{ display: 'flex', justifyContent: 'center', margin: '0.5rem 0' }}>
          <SkeletonBar height="2.25rem" width="min(24rem, 80%)" />
        </div>
        <div className={styles.composer}>
          <SkeletonBar height="3.25rem" />
        </div>
      </div>
    </div>
  );
}
