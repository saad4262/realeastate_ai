import Link from 'next/link';
import type { PublicListingSummary } from '@repo/core/listings';
/**
 * From the leaves, NOT from the ./listings barrel — the same reason
 * listing-card.tsx says so at length: the barrel reaches @repo/db and the web
 * build cannot resolve `fs`.
 */
import {
  addressLines,
  channelLabel,
  landLabel,
  listedLabel,
  priceLabel,
} from '@repo/core/listings/format';
import { propertyTypeLabel } from '@repo/core/listings/schema';
import { ListingMedia } from './listing-card';
import { Icon, type IconName } from './icons';

/**
 * One result, the way a portal shows it.
 *
 * `ListingCard` is still the right shape everywhere it is used — the home page,
 * the chat sidebar, anywhere the column is narrow. This is the wide one: a
 * full-width band of media with the price sitting on it, then the address and
 * specs underneath, then a row of actions. It exists because a 17rem grid card
 * in a 700px column is mostly empty space, and because the price on the media
 * rather than beside it is the single most recognisable thing about the
 * reference design.
 *
 * ## Why this is not one big <a>
 *
 * `ListingCard` wraps everything in a Link, which is fine when the whole card
 * does one thing. This row has a second action — enquire — and an anchor
 * inside an anchor is invalid HTML that browsers silently un-nest, which would
 * put the enquiry button outside the card.
 *
 * So the card is an <article>, the address is the only real link, and it
 * carries `after:absolute after:inset-0` — an overlay that makes the whole
 * card clickable without making it one link. The enquiry button sits above
 * that overlay on `relative z-10`. A screen reader hears one link named by the
 * address and one button, rather than a link whose accessible name is the
 * entire card.
 */

/** A listing published within the week, which is what a portal badges. */
const NEW_FOR_DAYS = 7;

function isNew(publishedAt: Date | null): boolean {
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) return false;
  return Date.now() - publishedAt.getTime() < NEW_FOR_DAYS * 86_400_000;
}

type SpecItem = { icon: IconName; value: string; label: string };

function Spec({
  icon,
  value,
  label,
}: SpecItem) {
  return (
    <span className="flex items-center gap-1.5 text-ink">
      <Icon name={icon} />
      <span className="text-data">{value}</span>
      {/* Visible on wide rows, read aloud always: "3" next to a bed outline is
          obvious to someone looking at it and silent to someone who is not. */}
      <span className="sr-only sm:not-sr-only sm:text-body-sm sm:text-ink-soft">{label}</span>
    </span>
  );
}

export function ResultRow({
  listing,
  searchedSuburb,
}: {
  listing: PublicListingSummary;
  /**
   * The suburb the visitor asked for, when they asked for one. Same reason as
   * on ListingCard: a Pakenham result labelled "3.5 km away" under a 2 km
   * filter reads as a broken filter, and it was reported as exactly that.
   */
  searchedSuburb?: string;
}) {
  const { street, locality } = addressLines(listing);
  const land = landLabel(listing.landAreaSqm);
  const listed = listedLabel(listing.publishedAt);
  const inSearchedSuburb =
    Boolean(searchedSuburb) &&
    listing.suburb.toLowerCase() === (searchedSuburb as string).toLowerCase();

  // Annotated rather than inferred: without it each branch widens to its own
  // literal icon type and the union is not assignable to the type predicate
  // below, which is a compiler error about a filter rather than about anything
  // real.
  const specs: SpecItem[] = ([
    listing.bedrooms !== null
      ? { icon: 'bed' as const, value: String(listing.bedrooms), label: 'Beds' }
      : null,
    listing.bathrooms !== null
      ? { icon: 'bath' as const, value: String(listing.bathrooms), label: 'Baths' }
      : null,
    listing.carSpaces !== null
      ? { icon: 'car' as const, value: String(listing.carSpaces), label: 'Car' }
      : null,
    land ? { icon: 'land' as const, value: land, label: '' } : null,
  ] as (SpecItem | null)[]).filter((s): s is SpecItem => s !== null);

  return (
    <article className="relative overflow-hidden rounded-md border border-line-subtle bg-card shadow-card transition hover:border-line-strong hover:shadow-raised motion-reduce:transition-none">
      {/* The agency strip. A portal leads each result with who is selling it —
          it is the one thing on the card that is not about the property. */}
      <div className="flex items-center justify-between gap-sm border-b border-line-subtle px-md py-2">
        <span className="truncate text-label-sm uppercase text-ink-faint">
          {listing.agencyName}
        </span>
        {listed ? <span className="shrink-0 text-label-sm text-ink-faint">{listed}</span> : null}
      </div>

      <ListingMedia listing={listing} className="aspect-[16/9] w-full sm:aspect-[21/9]">
        {/* Badges, top-left, in the reference's order: what the listing is,
            then whether it is new. */}
        <div className="absolute left-md top-md flex flex-wrap gap-1.5">
          <span className="rounded-sm bg-brand px-2 py-1 text-label-sm uppercase text-brand-ink">
            {channelLabel(listing.channel)}
          </span>
          {isNew(listing.publishedAt) ? (
            <span className="rounded-sm bg-card/95 px-2 py-1 text-label-sm uppercase text-ink">
              New to market
            </span>
          ) : null}
        </div>

        {/*
          The price, on the media.

          On a scrim rather than on the gradient alone: the hue is derived from
          the listing id and lands anywhere on the wheel, so white-on-gradient
          is legible for some listings and not others. A gradient to black
          along the bottom edge makes it legible for all of them without
          darkening the image a real photo will eventually be.
        */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-md pb-md pt-xl">
          <span className="font-display text-headline-lg text-white">{priceLabel(listing)}</span>
        </div>
      </ListingMedia>

      <div className="grid gap-sm p-md sm:p-lg">
        <div>
          <h3 className="text-headline-md text-ink">
            <Link
              href={`/listing/${listing.id}`}
              prefetch={false}
              /*
                `text-ink` is not decoration.

                Preflight is deliberately off and the one rule put back in
                `@layer base` resets `text-decoration` only — never `color`. So
                an anchor with no colour of its own falls back to the browser's
                link blue, which is exactly what every address on this page
                rendered as. The heading above it is `text-ink`; an anchor does
                not inherit that without being told.

                after:absolute/inset-0 is the overlay that makes the whole card
                clickable. See the note at the top of this file for why it is
                here and not a wrapper.
              */
              className="text-ink after:absolute after:inset-0 hover:text-brand"
            >
              {street}
            </Link>
          </h3>
          <p className="text-body-md text-ink-soft">{locality}</p>
        </div>

        {specs.length > 0 || listing.propertyType ? (
          <div className="flex flex-wrap items-center gap-x-lg gap-y-sm">
            {specs.map((s) => (
              <Spec key={s.icon} {...s} />
            ))}
            {listing.propertyType ? (
              <span className="rounded-sm bg-sunken px-2 py-0.5 text-label-md uppercase text-ink-soft">
                {propertyTypeLabel(listing.propertyType)}
              </span>
            ) : null}
          </div>
        ) : null}

        {listing.headline ? (
          <p className="line-clamp-2 text-body-md text-ink-soft">{listing.headline}</p>
        ) : null}

        <div className="mt-1 flex flex-wrap items-center justify-between gap-sm border-t border-line-subtle pt-md">
          {/* Which half of the union this result came from — the suburb itself,
              or the radius drawn around it. Distance only ever appears when the
              search had a centre, so it is never a distance from nowhere. */}
          {inSearchedSuburb ? (
            <span className="text-label-md uppercase text-brand">In {listing.suburb}</span>
          ) : listing.distanceKm !== null ? (
            <span className="text-label-md uppercase text-ink-faint">
              {listing.distanceKm.toFixed(1)} km away
            </span>
          ) : (
            <span />
          )}

          {/*
            Above the overlay, so it is a second destination rather than part of
            the card's one link. It goes to the same page, at the form — the
            enquiry is the only thing on this site that writes a lead, and it
            lives there.
          */}
          <Link
            href={`/listing/${listing.id}#enquire`}
            prefetch={false}
            className="relative z-10 rounded-sm bg-brand px-md py-2 text-label-md uppercase text-brand-ink transition hover:bg-brand-deep motion-reduce:transition-none"
          >
            Enquire now
          </Link>
        </div>
      </div>
    </article>
  );
}
