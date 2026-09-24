import Link from 'next/link';
import type { PublicListingSummary } from '@repo/core/listings';
/**
 * From the leaf, NOT from the ./listings barrel.
 *
 * This card is rendered inside a client component (the chat's results panel),
 * and the barrel re-exports update-listing.ts, which imports @repo/db, which
 * imports postgres.js, which imports `fs`. A value import from the barrel here
 * fails the web build with "Can't resolve 'fs'" — it did, once. The type
 * import above is erased at compile time and is safe.
 */
import { priceLabel, specLine } from '@repo/core/listings/format';
import styles from './listing-card.module.css';

/**
 * Re-exported because a card is still where most of the app reaches for these,
 * and because the model is only ever allowed to copy a figure someone else
 * formatted — non-negotiable #4.
 */
export { priceLabel, specLine };

export function ListingCard({
  listing,
  searchedSuburb,
}: {
  listing: PublicListingSummary;
  /**
   * The suburb the visitor asked for, when they asked for one.
   *
   * A search for "Pakenham + 2 km" returns every listing in Pakenham as well as
   * everything within 2 km of its centre — that union is the point, because a
   * suburb is wider than a small circle drawn from the middle of it. But a card
   * in Pakenham labelled "3.5 km away" under a 2 km filter reads as a broken
   * filter, which is exactly what it was reported as. Saying which half of the
   * union a result came from is what makes the behaviour legible.
   */
  searchedSuburb?: string;
}) {
  const inSearchedSuburb =
    Boolean(searchedSuburb) &&
    listing.suburb.toLowerCase() === (searchedSuburb as string).toLowerCase();

  return (
    <Link href={`/listing/${listing.id}`} className={styles.card} prefetch={false}>
      {/* No media yet — media rows land with the Cloudflare R2 upload path. */}
      <div className={styles.thumb} aria-hidden>
        <span className={styles.thumbText}>{listing.suburb}</span>
      </div>
      <div className={styles.body}>
        <div className={styles.price}>{priceLabel(listing)}</div>
        <div className={styles.address}>{listing.address}</div>
        {specLine(listing) ? <div className={styles.specs}>{specLine(listing)}</div> : null}
        {/* A result from the suburb half of the search says so; one the radius
            brought in shows how far out it is. Distance only ever appears when
            the search had a centre, so it is never a distance from nowhere. */}
        {inSearchedSuburb ? (
          <div className={styles.inSuburb}>In {listing.suburb}</div>
        ) : listing.distanceKm !== null ? (
          <div className={styles.distance}>{listing.distanceKm.toFixed(1)} km away</div>
        ) : null}
        {listing.headline ? <p className={styles.headline}>{listing.headline}</p> : null}
        <div className={styles.agency}>{listing.agencyName}</div>
      </div>
    </Link>
  );
}
