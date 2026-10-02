import type { PublicListingSummary } from './search-listings';

/**
 * How a listing is put into words.
 *
 * These lived in apps/web/components/listing-card.tsx, which was fine while a
 * card was the only thing that said a price out loud. The chat tools now hand
 * the model pre-formatted strings rather than raw numbers — non-negotiable #4,
 * the model never produces a figure — and two formatters would mean the bubble
 * and the card beside it could disagree about the same listing.
 *
 * THIS FILE IS A LEAF, and it must stay one: nothing here may import anything
 * that reaches @repo/db. It is published as `@repo/core/listings/format` so a
 * client component can call a formatter without going through the ./listings
 * barrel, which re-exports update-listing.ts → @repo/db → postgres.js → `fs`
 * and fails the web build outright. The PublicListing import below is
 * type-only and is erased at compile time.
 */

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

/**
 * What a buyer sees as the price.
 *
 * priceDisplay is the agency's own copy and wins whenever it is set; the
 * numeric range is only formatted as a fallback. The string is shown, never
 * parsed — non-negotiable #6.
 */
export function priceLabel(listing: PublicListingSummary): string {
  if (listing.channel === 'rent' || listing.channel === 'leased') {
    return listing.rentPw ? `${AUD.format(listing.rentPw)} per week` : 'Contact agent';
  }
  if (listing.priceDisplay) return listing.priceDisplay;
  if (listing.priceFrom && listing.priceTo) {
    return `${AUD.format(listing.priceFrom)} – ${AUD.format(listing.priceTo)}`;
  }
  if (listing.priceFrom) return AUD.format(listing.priceFrom);
  return 'Contact agent';
}

export function specLine(listing: PublicListingSummary): string {
  const parts = [
    listing.bedrooms !== null ? `${listing.bedrooms} bed` : null,
    listing.bathrooms !== null ? `${listing.bathrooms} bath` : null,
    listing.carSpaces !== null ? `${listing.carSpaces} car` : null,
    listing.propertyType,
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * Distance from the searched point, as a phrase.
 *
 * Null when the search had no centre, so the model is never handed a distance
 * from nowhere to repeat — the same rule the card follows.
 */
export function distanceLabel(distanceKm: number | null): string | null {
  if (distanceKm === null || !Number.isFinite(distanceKm)) return null;
  return `${distanceKm.toFixed(1)} km away`;
}

/** A price bound, spoken the way the chat summarises a filter. */
export function priceBoundLabel(amount: number, rental: boolean): string {
  return rental ? `${AUD.format(amount)} per week` : AUD.format(amount);
}

/** For sale / For rent, as a badge says it. */
export function channelLabel(channel: PublicListingSummary['channel']): string {
  switch (channel) {
    case 'rent':
      return 'For rent';
    case 'sold':
      return 'Sold';
    case 'leased':
      return 'Leased';
    default:
      return 'For sale';
  }
}

/** Land size, or null when the agency never entered one. */
export function landLabel(landAreaSqm: number | null): string | null {
  if (landAreaSqm === null || !Number.isFinite(landAreaSqm) || landAreaSqm <= 0) return null;
  return `${Math.round(landAreaSqm).toLocaleString('en-AU')} m²`;
}

const LISTED_ON = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * When the listing went up — as a date, never as "3 days ago".
 *
 * A relative date is computed at render time and is wrong the moment that
 * render is cached. `/listing/[id]` is force-dynamic today only because
 * notFound() answers 200 in production; the comment on that route says ISR is
 * re-enabled as soon as that is fixed, at which point "Listed 3 days ago"
 * would be served from a cache for up to an hour and then for a day. An
 * absolute date is true whenever it is read.
 */
export function listedLabel(publishedAt: Date | null): string | null {
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) return null;
  return `Listed ${LISTED_ON.format(publishedAt)}`;
}

/**
 * The address split the way a property page shows it: street line, then the
 * locality line.
 *
 * `address` is built by formatAddress and already ends with the suburb, state
 * and postcode, so printing both would say Pakenham twice. The street half is
 * taken by removing that tail rather than by re-deriving it, so the two can
 * never disagree about what the street line is.
 */
export function addressLines(listing: {
  address: string;
  suburb: string;
  state: string;
  postcode: string;
}): { street: string; locality: string } {
  const locality = `${listing.suburb}, ${listing.state} ${listing.postcode}`;
  const tail = `, ${locality}`;
  const street = listing.address.endsWith(tail)
    ? listing.address.slice(0, -tail.length)
    : listing.address;
  // A property with no street parts is just its suburb; showing an empty line
  // above the locality reads as a missing heading.
  return { street: street.trim() || locality, locality };
}

/**
 * Where a visitor reads the history this sale belongs to, or null.
 *
 * One rule, used by the /sold page and the guide's panel alike:
 * - nothing at the address on the market → `/property/<id>`, the off-market page;
 * - re-listed and live → that listing, whose page shows the same history;
 * - under offer → nowhere, because neither page exists for it.
 */
export function saleHistoryPath(
  s: { propertyId: string; onMarketNow: boolean; liveListingId: string | null },
): string | null {
  if (s.liveListingId) return `/listing/${s.liveListingId}`;
  return s.onMarketNow ? null : `/property/${s.propertyId}`;
}
