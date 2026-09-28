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

/**
 * The results, at the size the real ones will be.
 *
 * Rows now, not a 17rem grid — /search stacks one full-width result per line
 * beside a sidebar. The measurements are copied from ResultRow on purpose: the
 * agency strip, the 21/9 media band and the body below it. A skeleton in a
 * different shape from the thing it stands in for is a layout shift with extra
 * steps, which is exactly what the grid version became the day the results
 * stopped being a grid.
 */
export function ResultListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-md" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-md border border-line-subtle bg-card shadow-card"
        >
          <div className="border-b border-line-subtle px-md py-2">
            <Bar w="8rem" h="0.6875rem" />
          </div>
          {/* 21/9 on wide, 16/9 below — the same two frames ResultRow uses. */}
          <div className="aspect-[16/9] w-full animate-pulse bg-sunken sm:aspect-[21/9]" />
          <div className="grid content-start gap-sm p-md sm:p-lg">
            <Bar w="55%" h="1.125rem" />
            <Bar w="35%" />
            <Bar w="45%" h="0.875rem" />
            <Bar w="80%" h="0.9375rem" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One sidebar panel.
 *
 * The panels are their own Suspense boundary — two extra reads must not hold
 * the results back — so they need a fallback with height, or the sidebar
 * appears out of nowhere and pushes nothing, which on a sticky column reads as
 * the page finishing twice.
 */
export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div
      className="overflow-hidden rounded-md border border-line-subtle bg-card shadow-card"
      aria-hidden
    >
      <div className="border-b border-line-subtle px-md py-sm">
        <Bar w="9rem" h="0.75rem" />
      </div>
      <div className="divide-y divide-line-subtle">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-md px-md py-sm">
            <span className="size-9 shrink-0 animate-pulse rounded-full bg-sunken" />
            <span className="grid flex-1 gap-1">
              <Bar w="60%" h="0.9375rem" />
              <Bar w="40%" h="0.8125rem" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The listing page with its words removed.
 *
 * Built to the same measurements as the page itself — 1200px, the gallery's
 * one-large-plus-two grid, the in-page bar, the 8/4 split and the five-tile
 * spec strip — so the real page lands on top of this rather than replacing it.
 * It was built to the OLD page's measurements until the page was rebuilt to
 * the mock, at which point a skeleton in the right spirit and the wrong shape
 * is a layout shift with extra steps.
 */
export function ListingSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-gutter pb-xl" aria-hidden>
      <div className="py-md">
        <Bar w="18rem" h="0.8125rem" />
      </div>

      {/* The gallery grid, not a single band. */}
      <div className="grid gap-2 overflow-hidden rounded-xl sm:grid-cols-3 sm:grid-rows-2">
        <div className="aspect-[16/10] animate-pulse bg-sunken sm:col-span-2 sm:row-span-2 sm:aspect-auto sm:h-full sm:min-h-[22rem]" />
        <div className="hidden aspect-[4/3] animate-pulse bg-sunken sm:block" />
        <div className="hidden aspect-[4/3] animate-pulse bg-sunken sm:block" />
      </div>

      <div className="flex items-center justify-between py-sm">
        <Bar w="9rem" h="1.5rem" />
        <Bar w="7rem" h="0.75rem" />
      </div>

      {/* The in-page bar. */}
      <div className="-mx-gutter mb-lg flex h-12 items-center gap-lg border-y border-line-subtle bg-card px-gutter">
        {['4rem', '7rem', '5rem', '6rem'].map((w) => (
          <Bar key={w} w={w} h="0.8125rem" />
        ))}
      </div>

      <div className="grid items-start gap-lg lg:grid-cols-12">
        <div className="grid gap-lg lg:col-span-8">
          <div className="grid gap-sm rounded-xl border border-line-subtle bg-card p-lg shadow-card">
            <Bar w="7rem" h="0.6875rem" />
            <Bar w="14rem" h="2rem" />
            <Bar w="60%" h="1.125rem" />
            <Bar w="40%" h="0.9375rem" />
            {/* The five spec tiles, at their real size. */}
            <div className="mt-md grid grid-cols-2 gap-md rounded-xl bg-canvas p-md sm:grid-cols-5">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center gap-sm">
                  <span className="size-10 shrink-0 animate-pulse rounded-lg bg-sunken" />
                  <div className="grid flex-1 gap-1">
                    <Bar w="1.75rem" h="1.125rem" />
                    <Bar w="3rem" h="0.6875rem" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-sm rounded-xl border border-line-subtle bg-card p-lg shadow-card">
            <Bar w="10rem" h="1.5rem" />
            <Bar />
            <Bar />
            <Bar w="80%" />
          </div>
        </div>

        <div className="grid gap-md rounded-xl border border-line-subtle bg-card p-lg shadow-card lg:col-span-4">
          <Bar w="8rem" h="0.6875rem" />
          <Bar w="70%" h="1.125rem" />
          <div className="flex items-start gap-sm pt-sm">
            <div className="size-11 shrink-0 animate-pulse rounded-full bg-sunken" />
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
