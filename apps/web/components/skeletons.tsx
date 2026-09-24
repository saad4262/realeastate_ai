import styles from './skeleton.module.css';

/**
 * One grey block. `w`/`h` take any CSS length so a skeleton can be built to
 * the shape of the thing it replaces rather than from a fixed set of sizes.
 */
export function Bar({ w = '100%', h = '1rem' }: { w?: string; h?: string }) {
  return <span className={styles.bar} style={{ display: 'block', width: w, height: h }} />;
}

/**
 * The search bar's footprint.
 *
 * SearchBar reads useSearchParams, which forces a Suspense boundary around it.
 * That fallback used to be `null`, so the hero collapsed and then reflowed
 * once the bar hydrated — a layout shift on the two most-visited pages.
 */
export function SearchBarSkeleton() {
  return <div className={styles.searchBar} aria-hidden />;
}

/** A results grid, at the size the real one will be. */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className={styles.grid} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.card}>
          <div className={`${styles.bar} ${styles.cardThumb}`} />
          <div className={styles.cardBody}>
            <Bar w="45%" h="1.125rem" />
            <Bar w="85%" />
            <Bar w="60%" h="0.8125rem" />
            <Bar w="35%" h="0.75rem" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The listing page with its words removed.
 *
 * Built to the same measurements as listing.module.css — 860px, the 16/7 hero,
 * the head that splits address from price — so the real page lands on top of
 * this rather than replacing it.
 */
export function ListingSkeleton() {
  return (
    <div className={styles.listing} aria-hidden>
      <Bar w="8rem" h="0.875rem" />
      <div className={`${styles.bar} ${styles.listingHero}`} />
      <div className={styles.listingHead}>
        <div style={{ display: 'grid', gap: '0.5rem', flex: 1, minWidth: '15rem' }}>
          <Bar w="70%" h="1.75rem" />
          <Bar w="40%" h="0.9375rem" />
        </div>
        <Bar w="8rem" h="1.375rem" />
      </div>
      <Bar w="55%" h="1.125rem" />
      <div className={`${styles.bar} ${styles.block}`} style={{ height: 300 }} />
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        <Bar />
        <Bar />
        <Bar w="80%" />
      </div>
      <div className={styles.rule}>
        <Bar w="5rem" h="0.6875rem" />
        <div className={styles.factGrid} style={{ marginTop: '0.75rem' }}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} style={{ display: 'grid', gap: '0.25rem' }}>
              <Bar w="60%" h="0.75rem" />
              <Bar w="80%" h="0.9375rem" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
