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

/**
 * One shimmering block, for skeletons that are built out of a page's own CSS
 * module rather than out of this file's generic shapes.
 *
 * ARCHITECTURE.md § 10: a skeleton is built to the same measurements as the
 * real component, and the cheapest way to guarantee that is to render the real
 * component's own classes and fill the holes with these. Size comes in as a
 * style because the caller knows the measurement; the shimmer stays here so
 * there is one animation and one prefers-reduced-motion rule in the console.
 */
export function SkeletonBar({
  height,
  width = '100%',
  radius,
}: {
  height: number | string;
  width?: number | string;
  radius?: number | string;
}) {
  return (
    <span
      aria-hidden
      className={styles.bar}
      style={{ display: 'block', height, width, borderRadius: radius }}
    />
  );
}
