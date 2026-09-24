import styles from './page-skeleton.module.css';

/**
 * Shown by loading.tsx while a route segment fetches on the server.
 *
 * Every console page waits on at least one round trip to the database region,
 * so without this the browser sits on the previous screen and a click looks
 * like it did nothing. The layout stays put; only this area swaps.
 */
export function PageSkeleton({ rows = 1 }: { rows?: number }) {
  return (
    <div className={styles.wrap} aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className={`${styles.bar} ${styles.title}`} />
      <div className={`${styles.bar} ${styles.sub}`} />
      <div className={styles.stats}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={`${styles.bar} ${styles.stat}`} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`${styles.bar} ${styles.card}`} />
      ))}
    </div>
  );
}
