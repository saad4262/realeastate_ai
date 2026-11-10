import Link from 'next/link';
import Image from 'next/image';
import type { ReactNode } from 'react';
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
 * From the leaf, and value-safe in the browser: media-url.ts is string
 * concatenation over two NEXT_PUBLIC_ variables. The service-role storage
 * client lives behind `@repo/core/media/storage` and must never be imported
 * from anything that ships to a client.
 */
import { mediaUrl } from '@repo/core/media/url';

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
 * The media slot: a real photo when there is one, the drawn house (NoPhoto)
 * when there is not.
 *
 * THIS IS THE ONLY PLACE either decision is made. The results row, the chat's
 * sidebar card and the property page's gallery all render through here, so
 * "listings have photos now" was one component to change rather than three —
 * which is exactly why the frame was built this way before any photo existed.
 *
 * The shape has not moved: a frame that owns the aspect ratio, with the image
 * absolutely positioned inside it. `next/image` with `fill` needs precisely
 * that, so the photo dropped in as a sibling of the placeholder and nothing
 * about any of the three layouts shifted.
 *
 * The placeholder used to be a gradient whose hue came from the listing id,
 * so a page of them read as "photos not added" rather than "failed to load".
 * The drawn house says that outright, so it is the same on every listing.
 */
export function ListingMedia({
  listing,
  className,
  children,
  photoKey,
  alt,
  sizes = '(max-width: 640px) 100vw, (max-width: 1200px) 50vw, 640px',
  priority = false,
}: {
  /**
   * Only what the frame reads — so a sold property's page, which has no live
   * listing row, draws its gallery through the same component.
   */
  listing: Pick<PublicListingSummary, 'id' | 'mainPhotoKey' | 'address' | 'suburb'>;
  className: string;
  /**
   * Overlays drawn on top of the frame — badges, the price.
   *
   * Not `aria-hidden` like the placeholder beneath it, which is why the
   * attribute sits on the placeholder itself rather than on the wrapper: a price
   * hidden from a screen reader because it happens to sit on an image is a
   * price that page does not have.
   */
  children?: ReactNode;
  /**
   * A specific photo, for the gallery. Defaults to the listing's cover.
   *
   * A KEY, never a URL — `mediaUrl` is the one function that knows where
   * images are hosted, so moving off Supabase Storage never reaches this file.
   */
  photoKey?: string | null;
  /**
   * What the photo shows.
   *
   * Required in spirit: the gallery passes "Photo 3 of 8 of 12 Henry Street",
   * the cards pass the address. An empty alt would be right for pure
   * decoration and wrong here — on a property ad the photo IS the content, and
   * the address is the least useful thing it could say only if it were
   * repeated from an adjacent line, which on the results row it is not.
   */
  alt?: string;
  /** Handed to next/image so it fetches a width that matches the slot. */
  sizes?: string;
  /** Set on the one image above the fold — the gallery's hero. */
  priority?: boolean;
}) {
  const src = mediaUrl(photoKey === undefined ? listing.mainPhotoKey : photoKey);

  return (
    <div className={`relative shrink-0 overflow-hidden ${className}`}>
      {src ? (
        <Image
          src={src}
          alt={alt ?? listing.address}
          fill
          sizes={sizes}
          priority={priority}
          className="object-cover"
        />
      ) : (
        <NoPhoto suburb={listing.suburb} />
      )}
      {children}
    </div>
  );
}

/**
 * The frame of a listing with no photo: one drawn house, the same on every
 * listing (the user, 2026-11-10, replacing the per-listing colour gradient).
 *
 * A drawing and not a stock photo, on purpose. A photograph of somebody's
 * house on a listing that is not that house is a false picture of the
 * property in an advertisement; a line drawing cannot be mistaken for the
 * place. Inline SVG, so it costs no request and no image optimisation, and it
 * reads the skin's tokens, so it is slate under the portal skin and warm on
 * /chat.
 */
function NoPhoto({ suburb }: { suburb: string }) {
  return (
    <div
      aria-hidden
      className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-sunken px-2 text-center"
    >
      <svg
        viewBox="0 0 120 80"
        className="h-[48%] max-h-32 w-auto text-line-strong"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* ground */}
        <path d="M8 68h104" />
        {/* chimney, behind the roof */}
        <path d="M76 27V17h8v16" className="fill-card" />
        {/* body */}
        <path d="M34 38v30h52V38" className="fill-card" />
        {/* roof */}
        <path d="M26 41 60 14l34 27" />
        {/* door */}
        <path d="M54 68V52a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" className="fill-sunken" />
        {/* windows */}
        <rect x="40" y="45" width="10" height="9" rx="1" />
        <rect x="70" y="45" width="10" height="9" rx="1" />
        {/* tree */}
        <circle cx="101" cy="51" r="8" className="fill-card" />
        <path d="M101 59v9" />
        {/* shrub */}
        <path d="M14 68a6 6 0 0 1 12 0" className="fill-card" />
      </svg>
      <span className="text-label-sm uppercase text-ink-faint">{suburb}</span>
    </div>
  );
}

/** The name this file has always used internally. */
const Media = ListingMedia;

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
