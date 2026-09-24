import { cache } from 'react';
import type { PublicListingSummary, PublicSearchQuery } from '@repo/core/listings';
import type { Near } from '@repo/core/geo/schema';
import { ListingCard } from '../../components/listing-card';
import { ResultsMap } from '../../components/results-map';
import { cachedSearch } from '../../lib/cached';
import styles from '../home.module.css';

/**
 * The search, run once per request however many components ask for it.
 *
 * The summary line sits above the search box and the cards sit below it, so
 * they are two components with one question between them. Without the cache
 * that layout would cost two round trips to the database region on every
 * search — the shape of the page deciding how many queries it runs.
 */
const runSearch = cache(
  (query: PublicSearchQuery): Promise<{ rows: PublicListingSummary[]; down: boolean }> =>
    cachedSearch(query),
);

type Shared = {
  query: PublicSearchQuery;
  suburb?: string;
  place: string;
  near?: Near;
};

/**
 * One sentence that answers "is the distance filter working".
 *
 * A suburb-plus-radius search returns two different things and summing them
 * hides that: "3 results … within 2 km" next to a card marked 3.5 km reads as a
 * broken filter. Naming both halves is the difference between a number the
 * visitor has to trust and one they can check.
 */
export async function ResultsSummary({ query, suburb, place, near }: Shared) {
  const { rows, down } = await runSearch(query);
  if (down) return <p className={styles.sub}>Listings are temporarily unavailable.</p>;

  const inSuburb = suburb
    ? rows.filter((r) => r.suburb.toLowerCase() === suburb.toLowerCase()).length
    : 0;
  const nearby = rows.length - inSuburb;

  const kind = query.channel === 'rent' ? 'rentals' : 'properties for sale';
  const extras = [
    query.bedrooms ? `${query.bedrooms}+ bedrooms` : null,
    query.propertyType,
  ].filter(Boolean);

  const count = `${rows.length} ${rows.length === 1 ? 'result' : 'results'}`;

  if (near && place) {
    const tail = nearby
      ? `and ${nearby} more within ${near.radiusKm} km of it`
      : `and nothing else within ${near.radiusKm} km of it`;
    const detail = extras.length ? ` · ${extras.join(' · ')}` : '';
    return (
      <p className={styles.sub}>
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
    <p className={styles.sub}>
      {`${count} — ${[kind, where, ...extras].filter(Boolean).join(' ')}.`}
    </p>
  );
}

export async function ResultsList({ query, suburb, place, near }: Shared) {
  const { rows, down } = await runSearch(query);

  return (
    <>
      <ResultsMap
        pins={rows
          .filter((r) => r.latitude !== null && r.longitude !== null)
          .map((r) => ({
            id: r.id,
            lat: r.latitude as number,
            lng: r.longitude as number,
            label: r.address,
            href: `/listing/${r.id}`,
          }))}
        unpinned={rows.filter((r) => r.latitude === null).length}
      />

      {rows.length ? (
        <div className={styles.grid}>
          {rows.map((listing) => (
            <ListingCard key={listing.id} listing={listing} searchedSuburb={suburb} />
          ))}
        </div>
      ) : (
        <p className={styles.empty}>
          {down
            ? 'Please try again shortly.'
            : near
              ? `Nothing in ${place || 'that area'} or within ${near.radiusKm} km of it. Try a wider radius.`
              : place
                ? `Nothing listed in ${place} right now. Try searching the surrounding area instead.`
                : 'Nothing matched that search. Try a wider price range or a different suburb.'}
        </p>
      )}
    </>
  );
}
