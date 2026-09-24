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
