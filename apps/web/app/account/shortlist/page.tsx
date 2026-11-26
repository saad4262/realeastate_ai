import type { Metadata } from 'next';
import Link from 'next/link';
import { listShortlist, type ShortlistItem } from '@repo/core/shortlist';
import { priceLabel } from '@repo/core/listings/format';
import { MAX_PLAN_HOMES } from '@repo/core/inspections';
import { WebShell } from '../../../components/web-shell';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { requireWebUser } from '../../../lib/session';
import { CompareChooser } from './compare-chooser';
import { SavedList, type SavedHome } from './saved-list';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Saved homes', robots: { index: false, follow: false } };

const STANDING: Record<ShortlistItem['standing'], string> = {
  for_sale: 'For sale',
  for_rent: 'For rent',
  under_offer: 'Under offer',
  sold: 'Sold',
  leased: 'Leased',
  // ADR 0080 C4 decision 3: never "withdrawn", never why.
  not_advertised: 'No longer advertised',
};

/** The sort is in the URL (ARCHITECTURE § 4): it survives a refresh and Back, and needs no client state. */
const SORTS = {
  newest: 'Newest saved',
  'price-low': 'Price: low to high',
  'price-high': 'Price: high to low',
} as const;
type Sort = keyof typeof SORTS;

const day = (d: Date) =>
  d.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Australia/Sydney',
  });
const live = (i: ShortlistItem) => i.standing === 'for_sale' || i.standing === 'for_rent';
/** Sales before rentals, so a weekly rent never sorts among sale prices; a home with no figure goes last. */
const priceKey = (i: ShortlistItem): [number, number] => [
  i.channel === 'rent' ? 1 : 0,
  (i.channel === 'rent' ? i.rentPw : (i.priceFrom ?? i.priceTo)) ?? Number.NaN,
];

function sorted(items: ShortlistItem[], sort: Sort): ShortlistItem[] {
  if (sort === 'newest') return items; // listShortlist is newest first
  const dir = sort === 'price-low' ? 1 : -1;
  return [...items].sort((a, b) => {
    const [ga, pa] = priceKey(a);
    const [gb, pb] = priceKey(b);
    if (ga !== gb) return ga - gb;
    if (Number.isNaN(pa) || Number.isNaN(pb))
      return Number.isNaN(pa) ? (Number.isNaN(pb) ? 0 : 1) : -1;
    return (pa - pb) * dir;
  });
}

/**
 * Saved homes (ADR 0080 C4, ADR 0100). One read. A home no longer advertised stays, in its own section, so the
 * buyer's note is not lost; only the buyer sees any of it. Removal, Undo and notes are the list's (`SavedList`).
 */
export default async function ShortlistPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  await requireWebUser('/account/shortlist');
  const session = await ensureConsumerAccount();
  if (!session) return null;
  const asked = (await searchParams).sort;
  const sort: Sort = asked && asked in SORTS ? (asked as Sort) : 'newest';
  const items = sorted(await listShortlist(getWebDb(), { userId: session.id }), sort);
  const onMarket = items.filter(live);

  const homes: SavedHome[] = items.map((i) => ({
    id: i.listingId,
    href: live(i) ? `/listing/${i.listingId}` : null,
    available: live(i),
    mainPhotoKey: i.mainPhotoKey,
    street: i.address,
    locality: `${i.suburb} ${i.state}`,
    suburb: i.suburb,
    price:
      live(i) || i.standing === 'under_offer'
        ? priceLabel({
            channel: i.channel,
            priceDisplay: i.priceDisplay,
            priceFrom: i.priceFrom,
            priceTo: i.priceTo,
            rentPw: i.rentPw,
          } as Parameters<typeof priceLabel>[0])
        : null,
    standing: STANDING[i.standing],
    beds: i.bedrooms,
    baths: i.bathrooms,
    cars: i.carSpaces,
    savedOn: day(i.savedAt),
    priceChanged: i.lastPriceChangeAt ? day(i.lastPriceChangeAt) : null,
    note: i.note ?? '',
  }));

  return (
    <WebShell account={{ signedIn: true }}>
      <main className="mx-auto w-full max-w-5xl pb-xl pt-md">
        <p className="m-0 mb-2 text-body-sm">
          <Link href="/account" className="text-ink-soft hover:text-ink">
            ← Your account
          </Link>
        </p>

        <h1 className="m-0 font-display text-headline-xl text-ink">Saved homes</h1>

        <SavedList
          homes={homes}
          planMax={MAX_PLAN_HOMES}
          sortNav={
            <nav aria-label="Sort saved homes" className="mt-md flex flex-wrap gap-1.5">
              {(Object.keys(SORTS) as Sort[]).map((s) => (
                <Link
                  key={s}
                  href={s === 'newest' ? '/account/shortlist' : `/account/shortlist?sort=${s}`}
                  aria-current={s === sort ? 'page' : undefined}
                  scroll={false}
                  className={`rounded-full px-3 py-1.5 text-label-md font-semibold ${s === sort ? 'bg-ink text-white' : 'border border-line bg-card text-ink-soft hover:text-ink'}`}
                >
                  {SORTS[s]}
                </Link>
              ))}
            </nav>
          }
        />

        <CompareChooser
          homes={onMarket.map((i) => ({ id: i.listingId, title: `${i.address}, ${i.suburb}` }))}
        />
      </main>
    </WebShell>
  );
}
