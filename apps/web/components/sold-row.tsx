import Link from 'next/link';
import Image from 'next/image';
import { mediaUrl } from '@repo/core/media/url';
import type { SoldCard } from '@repo/ai/chat-events';
import { Icon, type IconName } from './icons';

/**
 * One completed sale, in the wide frame `/search` gives a live listing.
 *
 * `ResultRow`'s layout — agency strip, a full-width band of media with the
 * price on it, address, specs with icons, a footer — so `/sold` reads as the
 * same portal rather than a second one. What differs is what must differ: the
 * badge says SOLD in neutral ink, the price is what it sold for, and the one
 * action is the property's history, never an enquiry.
 *
 * Every figure is a string the SERVER formatted from SQL (#4).
 */
export function SoldResultRow({
  sale,
  searchedSuburb,
}: {
  sale: SoldCard;
  /** Same reason as on ResultRow: name the half of the search a row came from. */
  searchedSuburb?: string;
}) {
  const src = mediaUrl(sale.mainPhotoKey);
  const hue = Number.parseInt(sale.listingId.slice(0, 8), 16) % 360;
  // `address` is the full formatted line; the heading wants the street alone,
  // with the locality on the line under it — as ResultRow lays it out.
  const suffix = `, ${sale.suburb}, ${sale.state} ${sale.postcode}`;
  const street = sale.address.endsWith(suffix)
    ? sale.address.slice(0, -suffix.length)
    : sale.address;
  const inSearchedSuburb =
    Boolean(searchedSuburb) && sale.suburb.toLowerCase() === searchedSuburb!.toLowerCase();

  const specs = (
    [
      sale.bedrooms !== null ? { icon: 'bed', value: sale.bedrooms, label: 'Beds' } : null,
      sale.bathrooms !== null ? { icon: 'bath', value: sale.bathrooms, label: 'Baths' } : null,
      sale.carSpaces !== null ? { icon: 'car', value: sale.carSpaces, label: 'Car' } : null,
    ] as ({ icon: IconName; value: number; label: string } | null)[]
  ).filter((s) => s !== null);

  return (
    <article className="relative overflow-hidden rounded-md border border-line-subtle bg-card shadow-card transition hover:border-line-strong hover:shadow-raised motion-reduce:transition-none">
      <div className="flex items-center justify-between gap-sm border-b border-line-subtle px-md py-2">
        <span className="truncate text-label-sm uppercase text-ink-faint">{sale.agencyName}</span>
        <span className="shrink-0 text-label-sm text-ink-faint">Sold {sale.soldOn}</span>
      </div>

      <div className="relative aspect-[16/9] w-full overflow-hidden sm:aspect-[21/9]">
        {src ? (
          <Image
            src={src}
            alt={sale.address}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1200px) 66vw, 800px"
            className="object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background: `linear-gradient(135deg, hsl(${hue} 24% 62%), hsl(${(hue + 40) % 360} 20% 42%))`,
            }}
          />
        )}

        <div className="absolute left-md top-md">
          <span className="rounded-sm bg-ink/85 px-2 py-1 text-label-sm uppercase text-canvas">
            Sold
          </span>
        </div>

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-md pb-md pt-xl">
          <span className="font-display text-headline-lg text-white">{sale.price}</span>
        </div>
      </div>

      <div className="grid gap-sm p-md sm:p-lg">
        <div>
          <h3 className="text-headline-md text-ink">
            {sale.historyPath ? (
              // The overlay makes the whole card the one link, as on ResultRow.
              <Link
                href={sale.historyPath}
                prefetch={false}
                className="text-ink after:absolute after:inset-0 hover:text-brand"
              >
                {street}
              </Link>
            ) : (
              street
            )}
          </h3>
          <p className="text-body-md text-ink-soft">
            {sale.suburb}, {sale.state} {sale.postcode}
          </p>
        </div>

        {specs.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-lg gap-y-sm">
            {specs.map((s) => (
              <span key={s.icon} className="flex items-center gap-1.5 text-ink">
                <Icon name={s.icon} />
                <span className="text-data">{s.value}</span>
                <span className="sr-only sm:not-sr-only sm:text-body-sm sm:text-ink-soft">
                  {s.label}
                </span>
              </span>
            ))}
          </div>
        ) : null}

        {/* What the ad asked — the comparison people look at a sale for. */}
        {sale.priceDisplay ? (
          <p className="text-body-md text-ink-soft">Listed at {sale.priceDisplay}</p>
        ) : null}

        <div className="mt-1 flex flex-wrap items-center justify-between gap-sm border-t border-line-subtle pt-md">
          {inSearchedSuburb ? (
            <span className="text-label-md uppercase text-brand">In {sale.suburb}</span>
          ) : sale.distance ? (
            <span className="text-label-md uppercase text-ink-faint">{sale.distance} away</span>
          ) : (
            <span />
          )}

          {sale.forSaleNow ? (
            // Re-listed since this sale. The link is the live ad, whose page
            // carries this same history — one house, not a sold card and a
            // for-sale card that look like two.
            <span className="rounded-sm bg-brand px-md py-2 text-label-md uppercase text-brand-ink">
              For sale now · View listing
            </span>
          ) : sale.historyPath ? (
            <span className="rounded-sm border border-line px-md py-2 text-label-md uppercase text-ink">
              Property history
            </span>
          ) : (
            // Under offer: on the market, with no public page to send anyone to.
            <span className="text-label-md uppercase text-ink-faint">Under offer again</span>
          )}
        </div>
      </div>
    </article>
  );
}
