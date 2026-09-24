import { WebShell } from '../../components/web-shell';
import { CardGridSkeleton, SearchBarSkeleton, Bar } from '../../components/skeletons';

/**
 * Only ever seen on a COLD arrival at /search — from the home page, or a
 * pasted link.
 *
 * Searching from the search page does not reach this: SearchBar pushes inside
 * a useTransition, and a transition suppresses loading.tsx by design. That is
 * the better behaviour there — the box stays on screen with its own spinner in
 * the button, and the keyed Suspense boundaries swap only the results. The two
 * mechanisms compose rather than compete.
 */
export default function SearchLoading() {
  return (
    <WebShell wide>
      {/* The same container, order and rhythm as page.tsx — box, then the
          count line, then the grid. A skeleton in a different shape from the
          page it stands in for is a layout shift with extra steps. */}
      <div className="mx-auto w-full max-w-[1200px] px-gutter pb-xl">
        <div className="py-md">
          <SearchBarSkeleton />
        </div>
        <div className="border-b border-line-subtle pb-md">
          <Bar w="18rem" h="1.0625rem" />
        </div>
        <section className="pt-lg">
          <CardGridSkeleton count={6} />
        </section>
      </div>
    </WebShell>
  );
}
