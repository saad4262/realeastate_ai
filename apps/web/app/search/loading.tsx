import { WebShell } from '../../components/web-shell';
import { portalFonts } from '../portal-fonts';
import { ResultListSkeleton, PanelSkeleton, SearchBarSkeleton, Bar } from '../../components/skeletons';

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
      {/* The same skin, container, order and rhythm as page.tsx — box, heading,
          count line, then results beside a sidebar. A skeleton in a different
          shape from the page it stands in for is a layout shift with extra
          steps, and the portal skin has to be here too or the page arrives and
          changes colour. */}
      <div data-skin="portal" className={`${portalFonts} min-h-screen bg-canvas`}>
        <div className="mx-auto w-full max-w-[1200px] px-gutter pb-xl">
          <div className="py-md">
            <SearchBarSkeleton />
          </div>
          <div className="pt-sm">
            <Bar w="26rem" h="2rem" />
          </div>
          <div className="mt-sm border-b border-line-subtle pb-md">
            <Bar w="18rem" h="1.0625rem" />
          </div>
          <div className="grid items-start gap-lg pt-lg lg:grid-cols-12">
            <section className="lg:col-span-8">
              <ResultListSkeleton count={4} />
            </section>
            <aside className="grid gap-md lg:col-span-4">
              <PanelSkeleton rows={3} />
              <PanelSkeleton rows={4} />
            </aside>
          </div>
        </div>
      </div>
    </WebShell>
  );
}
