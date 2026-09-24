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
import { channelLabel, landLabel, priceLabel, specLine } from '@repo/core/listings/format';

/**
 * Re-exported because a card is still where most of the app reaches for these,
 * and because the model is only ever allowed to copy a figure someone else
 * formatted — non-negotiable #4.
 */
export { priceLabel, specLine };

/**
 * How much room the card has.
 *
 * `grid`  — the search results and the home page. Media on top, full detail.
 * `row`   — a wide list: media beside the text. Used where the column is wide
 *           enough that a grid card would leave half of it empty.
 * `compact` — the chat sidebar, where vertical space is the scarce thing.
 *
 * This replaced a `compact?: boolean`. A second boolean would have made the
 * two illegal combinations representable, and there was exactly one caller to
 * migrate.
 */
export type ListingCardVariant = 'grid' | 'row' | 'compact';

/**
 * The media slot.
 *
 * A frame that owns the aspect ratio with the gradient as an absolutely
 * positioned child, rather than a background on the frame itself. That is the
 * shape `next/image` with `fill` needs, so when the media table is finally
 * populated a photo drops in as a sibling and nothing about this layout moves.
 *
 * The hue is derived from the listing id. A results page of 24 identical green
 * rectangles reads as a page that failed to load; 24 different ones read as a
 * page whose photos have not been added. Same information, and it is the one
 * cheap thing that stops a photo-less portal looking broken.
 */
function Media({
  listing,
  className,
}: {
  listing: PublicListingSummary;
  className: string;
}) {
  let hash = 0;
  for (const ch of listing.id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  const from = `hsl(${(hash + 140) % 360} 42% 18%)`;
  const to = `hsl(${(hash + 170) % 360} 38% 32%)`;

  return (
    <div className={`relative shrink-0 overflow-hidden ${className}`} aria-hidden>
      <div
        className="absolute inset-0"
        style={{ backgroundImage: `linear-gradient(135deg, ${from}, ${to})` }}
      />
      <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-label-sm uppercase text-white/70">
        {listing.suburb}
      </span>
    </div>
  );
}

export function ListingCard({
  listing,
  searchedSuburb,
  variant = 'grid',
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
  variant?: ListingCardVariant;
}) {
  const inSearchedSuburb =
    Boolean(searchedSuburb) &&
    listing.suburb.toLowerCase() === (searchedSuburb as string).toLowerCase();

  const compact = variant === 'compact';
  const row = variant === 'row';
  const land = landLabel(listing.landAreaSqm);

  return (
    <Link
      href={`/listing/${listing.id}`}
      prefetch={false}
      className={[
        'group grid overflow-hidden rounded-lg border border-line-subtle bg-card',
        'shadow-card transition hover:border-line-strong hover:shadow-raised',
        'motion-reduce:transition-none',
        row ? 'grid-cols-[minmax(0,12rem)_1fr]' : 'grid-rows-[auto_1fr]',
      ].join(' ')}
    >
      <Media
        listing={listing}
        className={row ? 'h-full min-h-[8rem]' : compact ? 'aspect-[16/6]' : 'aspect-[16/10]'}
      />

      <div className={`grid content-start gap-1 ${compact ? 'p-sm' : 'p-md'}`}>
        <div className="flex items-baseline justify-between gap-sm">
          <span className={`font-display text-ink ${compact ? 'text-title-sm' : 'text-headline-md'}`}>
            {priceLabel(listing)}
          </span>
          {!compact ? (
            <span className="shrink-0 rounded-sm bg-brand-soft px-1.5 py-0.5 text-label-sm uppercase text-brand">
              {channelLabel(listing.channel)}
            </span>
          ) : null}
        </div>

        <div className="text-body-md text-ink">{listing.address}</div>

        {specLine(listing) ? (
          <div className="text-body-sm text-ink-soft">
            {specLine(listing)}
            {land && !compact ? ` · ${land}` : ''}
          </div>
        ) : null}

        {/* A result from the suburb half of the search says so; one the radius
            brought in shows how far out it is. Distance only ever appears when
            the search had a centre, so it is never a distance from nowhere. */}
        {inSearchedSuburb ? (
          <div className="text-label-md uppercase text-brand">In {listing.suburb}</div>
        ) : listing.distanceKm !== null ? (
          <div className="text-label-md uppercase text-ink-faint">
            {listing.distanceKm.toFixed(1)} km away
          </div>
        ) : null}

        {listing.headline && !compact ? (
          <p className="line-clamp-2 text-body-sm text-ink-soft">{listing.headline}</p>
        ) : null}

        <div className="mt-0.5 text-label-sm uppercase text-ink-faint">{listing.agencyName}</div>
      </div>
    </Link>
  );
}
