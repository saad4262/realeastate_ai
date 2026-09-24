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
    <div
      className="grid gap-md [grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))]"
      aria-hidden
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="grid grid-rows-[auto_1fr] overflow-hidden rounded-lg border border-line-subtle bg-card shadow-card"
        >
          {/* 16/10 — the same frame ListingCard's media slot uses, or this is a
              layout shift with extra steps. */}
          <div className="aspect-[16/10] w-full animate-pulse bg-sunken" />
          <div className="grid content-start gap-1 p-md">
            <Bar w="45%" h="1.125rem" />
            <Bar w="85%" />
            <Bar w="60%" h="0.8125rem" />
            <Bar w="35%" h="0.6875rem" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The listing page with its words removed.
 *
 * Built to the same measurements as the page itself — 1200px, the 16/7 media
 * frame, the 8/4 split and the spec row,
 * the head that splits address from price — so the real page lands on top of
 * this rather than replacing it.
 */
export function ListingSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-gutter pb-xl" aria-hidden>
      <div className="py-md">
        <Bar w="18rem" h="0.8125rem" />
      </div>
      {/* 16/7, the same frame the real media slot uses. */}
      <div className="aspect-[16/7] w-full animate-pulse rounded-lg bg-sunken" />

      <div className="mt-lg grid items-start gap-lg lg:grid-cols-12">
        <div className="grid gap-lg lg:col-span-8">
          <div className="grid gap-sm rounded-lg border border-line-subtle bg-card p-lg shadow-card">
            <Bar w="12rem" h="2rem" />
            <Bar w="60%" h="1.125rem" />
            <Bar w="40%" h="0.9375rem" />
            <div className="mt-md grid grid-cols-2 gap-sm rounded-md bg-canvas p-md sm:grid-cols-5">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="grid gap-1">
                  <Bar w="2.5rem" h="1.125rem" />
                  <Bar w="3rem" h="0.6875rem" />
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-sm rounded-lg border border-line-subtle bg-card p-lg shadow-card">
            <Bar w="10rem" h="1.125rem" />
            <Bar />
            <Bar />
            <Bar w="80%" />
          </div>
        </div>

        <div className="grid gap-md rounded-lg border border-line-subtle bg-card p-lg shadow-card lg:col-span-4">
          <Bar w="8rem" h="0.6875rem" />
          <Bar w="70%" h="1.125rem" />
          <div className="flex items-start gap-sm pt-sm">
            <div className="size-12 shrink-0 animate-pulse rounded-full bg-sunken" />
            <div className="grid flex-1 gap-1">
              <Bar w="60%" h="0.9375rem" />
              <Bar w="45%" h="0.8125rem" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
