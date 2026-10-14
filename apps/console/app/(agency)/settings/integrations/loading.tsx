import { SkeletonBar } from '@/components/page-skeleton';
import contactStyles from '@/components/contacts/contacts.module.css';
import styles from '@/components/integrations/integrations.module.css';

/** The Connectors page's shape while the database answers — rail and grid, from the page's own classes. */
export default function Loading() {
  return (
    <div className={contactStyles.wrap} aria-busy="true">
      <span className="sr-only">Loading</span>
      <div className={styles.layout}>
        <div className={styles.rail}>
          <SkeletonBar height="36px" radius="0.5rem" />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} style={{ padding: '0.5rem 0.75rem' }}>
              <SkeletonBar height="0.8125rem" width={i % 2 ? '60%' : '75%'} />
            </div>
          ))}
        </div>
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <SkeletonBar height="0.9375rem" width="7rem" />
          </div>
          <div className={styles.hero}>
            <div style={{ display: 'grid', justifyItems: 'center', gap: '0.5rem' }}>
              <SkeletonBar height="1.5rem" width="min(20rem, 80%)" />
              <SkeletonBar height="0.875rem" width="min(30rem, 90%)" />
            </div>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.grid}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={styles.card}>
                  <div className={styles.cardMain}>
                    <SkeletonBar height="2.5rem" width="2.5rem" radius="0.625rem" />
                    <div className={styles.cardText}>
                      <SkeletonBar height="0.875rem" width="50%" />
                      <SkeletonBar height="0.75rem" width="85%" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
