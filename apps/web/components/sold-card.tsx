import Link from 'next/link';
import Image from 'next/image';
import { mediaUrl } from '@repo/core/media/url';
import type { SoldCard as SoldCardData } from '@repo/ai/chat-events';

/**
 * A completed sale, in the same frame a live listing gets.
 *
 * Deliberately the same shape as `ListingCard` — same radius, border, shadow,
 * media ratio and type scale — because a visitor scanning results should not
 * have to learn a second card. What differs is exactly what must differ:
 *
 * - the chip says **SOLD**, in the neutral ink rather than the brand colour, so
 *   it does not read as a call to action;
 * - the price is what it SOLD for, with the asking price beneath it when the ad
 *   had one, because "listed at X, sold for Y" is the comparison people came for;
 * - there is no enquiry affordance anywhere, because nobody can enquire about it.
 *
 * It is a `<Link>` only when the property page will actually render.
 * `/property/[id]` refuses while anything at the address is live or under
 * offer, so a re-listed sale is a plain card that says so rather than a link
 * to a 404.
 *
 * Every figure here is a string the SERVER formatted from SQL. This component
 * does no arithmetic and never sees a raw number (#4).
 */
function Media({ sale, className }: { sale: SoldCardData; className: string }) {
  const src = mediaUrl(sale.mainPhotoKey);

  /**
   * The same hue-from-id fallback the listing card uses: a page of identical
   * grey rectangles reads as a page that failed to load, while different ones
   * read as photos not yet added.
   */
  const hue = Number.parseInt(sale.listingId.slice(0, 8), 16) % 360;

  return (
    <div className={`relative overflow-hidden bg-canvas ${className}`}>
      {src ? (
        <Image
          src={src}
          alt=""
          fill
          sizes="(max-width: 768px) 100vw, 320px"
          className="object-cover transition duration-300 group-hover:scale-[1.02] motion-reduce:transition-none"
        />
      ) : (
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background: `linear-gradient(135deg, hsl(${hue} 24% 82%), hsl(${(hue + 40) % 360} 20% 70%))`,
          }}
        />
      )}
      {/*
        The badge sits on the media, like a portal's does, so the card reads as
        sold before the eye reaches the price.
      */}
      <span className="absolute left-2 top-2 rounded-sm bg-ink/85 px-1.5 py-0.5 text-label-sm uppercase tracking-wide text-canvas">
        Sold
      </span>
    </div>
  );
}

export function SoldListingCard({
  sale,
  variant = 'grid',
}: {
  sale: SoldCardData;
  /** `compact` for the chat sidebar, `grid` for the browse page. */
  variant?: 'grid' | 'compact';
}) {
  const compact = variant === 'compact';

  const specs = [
    sale.bedrooms !== null ? `${sale.bedrooms} bd` : null,
    sale.bathrooms !== null ? `${sale.bathrooms} ba` : null,
    sale.carSpaces !== null ? `${sale.carSpaces} car` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const body = (
    <>
      <Media sale={sale} className={compact ? 'aspect-[16/6]' : 'aspect-[16/10]'} />

      <div className={`grid content-start gap-1 ${compact ? 'p-sm' : 'p-md'}`}>
        <div className="flex items-baseline justify-between gap-sm">
          <span
            className={`font-display text-ink ${compact ? 'text-title-sm' : 'text-headline-md'}`}
          >
            {sale.price}
          </span>
          <span className="shrink-0 text-label-sm uppercase text-ink-faint">{sale.soldOn}</span>
        </div>

        <div className="text-body-md text-ink">{sale.address}</div>

        {specs ? <div className="text-body-sm text-ink-soft">{specs}</div> : null}

        {/* What the ad asked, when it asked anything. The comparison is the
            reason somebody looks at a sold record at all. */}
        {sale.priceDisplay && !compact ? (
          <div className="text-body-sm text-ink-faint">Listed at {sale.priceDisplay}</div>
        ) : null}

        {sale.distance ? (
          <div className="text-label-md uppercase text-ink-faint">{sale.distance} away</div>
        ) : null}

        <div className="mt-0.5 flex items-center justify-between gap-sm">
          <span className="text-label-sm uppercase text-ink-faint">{sale.agencyName}</span>
          {sale.forSaleNow ? (
            // Re-listed: the link is the live ad, which carries this history.
            <span className="text-label-sm uppercase text-brand group-hover:underline">
              For sale now · View listing
            </span>
          ) : sale.historyPath ? (
            <span className="text-label-sm uppercase text-brand group-hover:underline">
              Full history
            </span>
          ) : (
            <span className="text-label-sm uppercase text-ink-faint">Under offer again</span>
          )}
        </div>
      </div>
    </>
  );

  const frame = [
    'group grid overflow-hidden rounded-lg border border-line-subtle bg-card',
    'shadow-card transition motion-reduce:transition-none grid-rows-[auto_1fr]',
  ].join(' ');

  return sale.historyPath ? (
    <Link
      href={sale.historyPath}
      prefetch={false}
      className={`${frame} hover:border-line-strong hover:shadow-raised`}
    >
      {body}
    </Link>
  ) : (
    <div className={frame}>{body}</div>
  );
}
