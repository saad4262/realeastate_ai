import { cache } from 'react';
import Link from 'next/link';
import type { PublicListingSummary, PublicSearchQuery } from '@repo/core/listings';
import { PAGE_GAP, pageWindow } from '@repo/core/listings/pagination';
import type { Near } from '@repo/core/geo/schema';
import { ResultRow } from '../../components/result-row';
import { ResultsMap } from '../../components/results-map';
import { PrefetchOnIntent } from '../../components/prefetch-on-intent';
import { cachedSearch } from '../../lib/cached';

/**
 * The search, run once per request however many components ask for it.
 *
 * The summary line sits above the search box and the cards sit below it, so
 * they are two components with one question between them. Without the cache
 * that layout would cost two round trips to the database region on every
 * search — the shape of the page deciding how many queries it runs.
 */
const runSearch = cache(
  (
    query: PublicSearchQuery,
  ): Promise<{ rows: PublicListingSummary[]; total: number; down: boolean }> =>
    cachedSearch(query),
);

type Shared = {
  query: PublicSearchQuery;
  suburb?: string;
  place: string;
  near?: Near;
  /** 1-based. */
  page: number;
  pageSize: number;
  pageHref: (n: number) => string;
};

/**
 * One sentence that answers "is the distance filter working".
 *
 * A suburb-plus-radius search returns two different things and summing them
 * hides that: "3 results … within 2 km" next to a card marked 3.5 km reads as a
 * broken filter. Naming both halves is the difference between a number the
 * visitor has to trust and one they can check.
 */
export async function ResultsSummary({
  query,
  suburb,
  place,
  near,
  page,
  pageSize,
}: Shared) {
  const { rows, total, down } = await runSearch(query);
  if (down) return <p className="text-body-md text-ink-soft">Listings are temporarily unavailable.</p>;

  const inSuburb = suburb
    ? rows.filter((r) => r.suburb.toLowerCase() === suburb.toLowerCase()).length
    : 0;
  const nearby = rows.length - inSuburb;

  const kind = query.channel === 'rent' ? 'rentals' : 'properties for sale';
  const extras = [
    query.bedrooms ? `${query.bedrooms}+ bedrooms` : null,
    query.propertyType,
  ].filter(Boolean);

  /**
   * The total, and which slice of it is on screen.
   *
   * This used to read rows.length, which was the same number as the total only
   * because the search was capped at 48 and had no second page. Saying "24
   * results" under a search that found 300 would be worse than saying nothing.
   */
  const from = (page - 1) * pageSize + 1;
  const to = from + rows.length - 1;
  const count =
    total > rows.length
      ? `${total} results — showing ${from}–${to}`
      : `${total} ${total === 1 ? 'result' : 'results'}`;

  /**
   * The suburb/radius split only makes sense for the whole result set.
   *
   * It exists to answer "is the distance filter working" — a search for
   * Pakenham + 2 km returns everything IN Pakenham as well as everything
   * within 2 km of its centre, and naming both halves is what stops a card
   * marked 3.5 km reading as a broken filter.
   *
   * Counted over one page it says something false. With one listing per page,
   * page 1 read "1 in Pakenham, and nothing else within 50 km of it" while
   * page 3 held exactly that nothing-else. So once there is more than one
   * page, the sentence states the search instead of dissecting a page of it.
   */
  const paged = total > rows.length;

  if (near && place) {
    const detail = extras.length ? ` · ${extras.join(' · ')}` : '';
    if (paged) {
      return (
        <p className="text-body-md text-ink-soft">
          {`${count} — ${kind} in ${place} and within ${near.radiusKm} km of it.${detail}`}
        </p>
      );
    }
    const tail = nearby
      ? `and ${nearby} more within ${near.radiusKm} km of it`
      : `and nothing else within ${near.radiusKm} km of it`;
    return (
      <p className="text-body-md text-ink-soft">
        {`${count} — ${inSuburb} ${kind} in ${place}, ${tail}.${detail}`}
      </p>
    );
  }

  const where = near
    ? `within ${near.radiusKm} km of your chosen location`
    : place
      ? `in ${place}`
      : query.text
        ? `matching “${query.text}”`
        : null;

  return (
    <p className="text-body-md text-ink-soft">
      {`${count} — ${[kind, where, ...extras].filter(Boolean).join(' ')}.`}
    </p>
  );
}

export async function ResultsList({
  query,
  suburb,
  place,
  near,
  page,
  pageSize,
  pageHref,
}: Shared) {
  const { rows, total, down } = await runSearch(query);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  // Built once, and `unpinned` counted from what is left over rather than by
  // re-testing latitude. A row with a latitude but no longitude cannot be
  // placed either, and counting only null latitudes left it out of both the
  // map and the tally — the "12 results, nine markers" gap this note exists
  // to close.
  const pins = rows
    .filter((r) => r.latitude !== null && r.longitude !== null)
    .map((r) => ({
      id: r.id,
      lat: r.latitude as number,
      lng: r.longitude as number,
      label: r.address,
      href: `/listing/${r.id}`,
    }));

  return (
    <>
      <ResultsMap pins={pins} unpinned={rows.length - pins.length} />

      {/*
        A stacked list, not a grid of cards.

        The results now sit in an 8-of-12 column beside a sidebar, and a
        17rem auto-fill grid in that column produced two cramped cards per row
        with a ragged last line. One full-width row per listing is what the
        reference does and what the column is shaped for — and it is the only
        layout with room for the price on the media, the specs with icons, and
        a second action.
      */}
      {rows.length ? (
        <PrefetchOnIntent className="grid gap-md">
          {rows.map((listing) => (
            <ResultRow key={listing.id} listing={listing} searchedSuburb={suburb} />
          ))}
        </PrefetchOnIntent>
      ) : (
        <p className="rounded-lg border border-dashed border-line px-lg py-xl text-center text-body-md text-ink-soft">
          {down
            ? 'Please try again shortly.'
            : near
              ? `Nothing in ${place || 'that area'} or within ${near.radiusKm} km of it. Try a wider radius.`
              : place
                ? `Nothing listed in ${place} right now. Try searching the surrounding area instead.`
                : 'Nothing matched that search. Try a wider price range or a different suburb.'}
        </p>
      )}

      {/*
        Links, not a "load more" button.
        
        Appending to a client-held list would make server data into client
        state, which is the one thing this app deliberately never does — and it
        breaks the Back button. Each page is its own URL instead: shareable,
        cacheable, in the history, indexable, and it works with no JavaScript.
      */}
      {pages > 1 ? (
        <nav className="mt-lg flex flex-wrap items-center justify-center gap-1" aria-label="Search result pages">
          <PageLink href={pageHref(page - 1)} disabled={page === 1} rel="prev">
            ← Previous
          </PageLink>

          {pageWindow(page, pages).map((n, i) =>
            n === PAGE_GAP ? (
              <span key={`gap-${i}`} className="px-sm text-body-sm text-ink-faint" aria-hidden>
                …
              </span>
            ) : n === page ? (
              // The current page is not a link to itself. aria-current is what
              // tells a screen reader which one it is on; the styling is what
              // tells everyone else.
              <span
                key={n}
                aria-current="page"
                className="min-w-9 rounded-sm bg-brand px-sm py-2 text-center text-body-sm text-brand-ink"
              >
                {n}
              </span>
            ) : (
              <PageLink key={n} href={pageHref(n)}>
                {n}
              </PageLink>
            ),
          )}

          <PageLink href={pageHref(page + 1)} disabled={page === pages} rel="next">
            Next →
          </PageLink>
        </nav>
      ) : null}
    </>
  );
}

/**
 * One page control.
 *
 * A disabled control is a <span>, not a disabled <a> — there is no such thing.
 * Previous on page one has nowhere to go, so it is not a link at all rather
 * than a link that navigates to the page you are on.
 */
function PageLink({
  href,
  children,
  disabled = false,
  rel,
}: {
  href: string;
  children: React.ReactNode;
  disabled?: boolean;
  rel?: string;
}) {
  const base = 'min-w-9 rounded-sm border px-sm py-2 text-center text-body-sm';
  if (disabled) {
    return (
      <span className={`${base} border-line-subtle text-ink-faint opacity-50`} aria-hidden>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} rel={rel} className={`${base} border-line bg-card text-ink hover:border-brand hover:text-brand`}>
      {children}
    </Link>
  );
}
