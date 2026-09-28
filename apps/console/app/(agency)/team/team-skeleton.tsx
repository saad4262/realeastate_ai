import { SkeletonBar } from '@/components/page-skeleton';
import styles from './team.module.css';

/**
 * The directory's own shape, out of the directory's own CSS module.
 *
 * `/team` is full-bleed inside the console shell — a two-pane layout with its
 * own header, tab rail, three KPI cards and a wide table. The console-wide
 * PageSkeleton is a centred column with three stat tiles and one card, so it
 * read as a different screen arriving rather than as this one loading, which is
 * exactly what ARCHITECTURE.md § 10 asks a loader not to do.
 */
export function TeamSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className={styles.layout} data-full-bleed aria-busy="true" aria-live="polite">
      <div className={styles.main}>
        <span className="sr-only">Loading the roster</span>

        <div className={styles.head}>
          <div>
            <SkeletonBar height={24} width={320} radius="0.375rem" />
            <div style={{ marginTop: '0.5rem' }}>
              <SkeletonBar height={13} width={440} radius="0.25rem" />
            </div>
          </div>
          <div className={styles.actions}>
            <SkeletonBar height={33} width={236} radius="0.5rem" />
          </div>
        </div>

        <div className={styles.tabs}>
          {[112, 92, 132].map((w) => (
            <div key={w} className={styles.tab}>
              <SkeletonBar height={13} width={w} radius="0.25rem" />
            </div>
          ))}
        </div>

        <div className={styles.kpiGrid}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.kpi}>
              <div className={styles.kpiTop}>
                <SkeletonBar height={10} width={84} radius="0.25rem" />
              </div>
              <div className={styles.kpiVal}>
                <SkeletonBar height={24} width={48} radius="0.375rem" />
              </div>
            </div>
          ))}
        </div>

        <div className={styles.card}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <tbody>
                {Array.from({ length: rows }, (_, i) => (
                  <tr key={i}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <SkeletonBar height={36} width={36} radius="9999px" />
                        <div style={{ display: 'grid', gap: 6, flex: 1 }}>
                          <SkeletonBar height={13} width={150} radius="0.25rem" />
                          <SkeletonBar height={11} width={104} radius="0.25rem" />
                        </div>
                      </div>
                    </td>
                    <td><SkeletonBar height={12} width={96} radius="0.25rem" /></td>
                    <td><SkeletonBar height={12} width={148} radius="0.25rem" /></td>
                    <td><SkeletonBar height={20} width={72} radius="9999px" /></td>
                    <td><SkeletonBar height={12} width={176} radius="0.25rem" /></td>
                    <td><SkeletonBar height={20} width={120} radius="9999px" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
