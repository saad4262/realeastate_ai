import type { Metadata } from 'next';
import { saleHistoryPath } from '@repo/core/listings/format';
import { Suspense } from 'react';
import Link from 'next/link';
import type { SoldCard } from '@repo/ai/chat-events';
import { nearSchema } from '@repo/core/geo/schema';
import { WebShell } from '../../components/web-shell';
import { SoldResultRow } from '../../components/sold-row';
import { ResultsMap } from '../../components/results-map';
import { NotConnectedPanel, Panel } from '../search/sidebar';
import { SearchBar } from '../../components/search-bar';
import { SearchBarSkeleton } from '../../components/skeletons';
import { Refreshing, SortBar, SortingProvider } from '../search/sorting';
import type { RecentSalesSort } from '@repo/core/listings';
import { looksSignedIn } from '../../lib/session';
import { cachedPlace, cachedRecentSalesPage } from '../../lib/cached';
import { portalFonts } from '../portal-fonts';

export const dynamic = 'force-dynamic';

/** A page people scroll rather than abandon, matching /search. */
const PAGE_SIZE = 24;
const DEFAULT_MONTHS = 24;

/**
 * What has sold, browsable.
 *
 * The counterpart to `/search`, and built to the same shape on purpose: the
 * same card frame, the same page size, the same pager. A visitor should not
 * have to learn a second results page.
 *
 * ## Not indexed
 *
 * `noindex`, like `/property/[id]`. The pages are reachable by anyone with the
 * link and are deliberately not advertised — a crawlable index of
 * recently-sold addresses is a directory this platform did not set out to
 * publish, and the decision to make sold data browsable from the guide did not
 * change that. See docs/adr/0012.
 */
export const metadata: Metadata = {
  title: 'Recently sold — Property Platform',
  robots: { index: false, follow: false },
};

function intParam(raw: string | string[] | undefined, fallback: number): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function sortOf(raw: string | string[] | undefined): RecentSalesSort | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'price_asc' || value === 'price_desc' || value === 'newest' ? value : undefined;
}

function strParam(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() ? value.trim() : undefined;
}

export default async function SoldPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const suburb = strParam(params.suburb);
  const state = strParam(params.state);
  const postcode = strParam(params.postcode);
  // `radius` is what the search box and /search write; `radiusKm` is what the
  // guide's links have always carried. Both mean the same circle.
  const radiusRaw = params.radius ?? params.radiusKm;
  const radiusKm = radiusRaw === undefined ? undefined : intParam(radiusRaw, 0);
  const sort = sortOf(params.sort);
  const months = intParam(params.months, DEFAULT_MONTHS);
  const page = intParam(params.page, 1);

  /**
   * The radius is centred here, from the geocoder, exactly as the chat tool
   * does it — the URL names a place and never carries a coordinate, so a
   * forged lat/lng has nowhere to arrive.
   */
  let near: { lat: number; lng: number; radiusKm: number } | undefined;
  if (suburb && radiusKm) {
    const place = await cachedPlace([suburb, state, 'Australia'].filter(Boolean).join(', '));
    const parsed = place
      ? nearSchema.safeParse({ lat: place.latitude, lng: place.longitude, radiusKm })
      : null;
    if (parsed?.success) near = parsed.data;
  }

  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const [result, signedIn] = await Promise.all([
    cachedRecentSalesPage({
      ...(suburb ? { suburb } : {}),
      ...(state ? { state } : {}),
      ...(near ? { near } : {}),
      since,
      // Nearest is the default once there is a centre, as on /search.
      sort: sort ?? (near ? 'nearest' : 'newest'),
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    looksSignedIn(),
  ]);

  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const hrefFor = (n: number) => {
    const q = new URLSearchParams();
    if (suburb) q.set('suburb', suburb);
    if (state) q.set('state', state);
    if (postcode) q.set('postcode', postcode);
    if (radiusKm) q.set('radius', String(radiusKm));
    if (months !== DEFAULT_MONTHS) q.set('months', String(months));
    if (sort) q.set('sort', sort);
    if (n > 1) q.set('page', String(n));
    const s = q.toString();
    return s ? `/sold?${s}` : '/sold';
  };

  // Formatted here, by the server, exactly as the chat frame formats them —
  // the row never does arithmetic (#4).
  const sales: SoldCard[] = result.rows.map((sale) => ({
    listingId: sale.listingId,
    propertyId: sale.propertyId,
    address: sale.address,
    suburb: sale.suburb,
    state: sale.state,
    postcode: sale.postcode,
    price: AUD.format(sale.soldPrice),
    soldOn: SOLD_ON.format(sale.soldDate),
    agencyName: sale.agencyName,
    bedrooms: sale.bedrooms,
    bathrooms: sale.bathrooms,
    carSpaces: sale.carSpaces,
    distance: sale.distanceKm === null ? null : `${sale.distanceKm.toFixed(1)} km`,
    mainPhotoKey: sale.mainPhotoKey,
    priceDisplay: sale.priceDisplay,
    latitude: sale.latitude,
    longitude: sale.longitude,
    historyPath: saleHistoryPath(sale),
        forSaleNow: sale.liveListingId !== null,
  }));

  const pins = sales
    .filter((s) => s.latitude !== null && s.longitude !== null)
    .map((s) => ({
      id: s.listingId,
      lat: s.latitude as number,
      lng: s.longitude as number,
      label: `${s.price} · ${s.address}`,
      href: s.historyPath ?? undefined,
    }));

  const place = [suburb, state].filter(Boolean).join(' ');
  const where = suburb
    ? near
      ? `in ${place} and within ${near.radiusKm} km of it`
      : `in ${place}`
    : 'across the portal';

  /**
   * The same sentence shape /search uses: the count, then which half of a
   * suburb-plus-radius search each row came from, so a card marked "5.6 km
   * away" under "Pakenham" does not read as a broken filter.
   */
  const inSuburb = suburb
    ? sales.filter((s) => s.suburb.toLowerCase() === suburb.toLowerCase()).length
    : 0;
  const paged = result.total > sales.length;
  const from = (page - 1) * PAGE_SIZE + 1;
  const count = paged
    ? `${result.total} sales — showing ${from}–${from + sales.length - 1}`
    : `${result.total} ${result.total === 1 ? 'sale' : 'sales'}`;
  const summary =
    result.total === 0
      ? `No sales recorded ${where} in the last ${months} months.`
      : near && suburb && !paged
        ? `${count} — ${inSuburb} in ${place}, ${
            sales.length - inSuburb
              ? `and ${sales.length - inSuburb} more within ${near.radiusKm} km of it`
              : `and nothing else within ${near.radiusKm} km of it`
          }, in the last ${months} months.`
        : `${count} recorded ${where} in the last ${months} months.`;

  /** For sale in the same place — the question a sold record usually leads to. */
  const forSaleHref = (() => {
    const q = new URLSearchParams({ channel: 'sale' });
    if (suburb) q.set('suburb', suburb);
    if (state) q.set('state', state);
    if (radiusKm) q.set('radius', String(radiusKm));
    return `/search?${q.toString()}`;
  })();

  /** Sort as links, exactly as /search does — the href IS the ordering. */
  const sortHref = (value: string) => {
    const q = new URLSearchParams();
    if (suburb) q.set('suburb', suburb);
    if (state) q.set('state', state);
    if (postcode) q.set('postcode', postcode);
    if (radiusKm) q.set('radius', String(radiusKm));
    if (months !== DEFAULT_MONTHS) q.set('months', String(months));
    if (value) q.set('sort', value);
    const qs = q.toString();
    return qs ? `/sold?${qs}` : '/sold';
  };
  const sorts = [
    { value: '', label: near ? 'Nearest' : 'Newest' },
    ...(near ? [{ value: 'newest', label: 'Newest' }] : []),
    { value: 'price_asc', label: 'Price ↑' },
    { value: 'price_desc', label: 'Price ↓' },
  ].map((o) => ({ ...o, href: sortHref(o.value) }));
  const currentSort = sort === 'newest' && !near ? '' : (sort ?? '');

  return (
    <WebShell wide account={{ signedIn }}>
      <SortingProvider>
      <div
        data-skin="portal"
        data-page="sold-index"
        className={`${portalFonts} min-h-screen bg-canvas`}
      >
        <div className="mx-auto w-full max-w-[1200px] px-gutter pb-xl">
          <nav
            aria-label="Breadcrumb"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 py-md text-body-sm text-ink-soft"
          >
            <Link href="/" className="text-ink-soft hover:text-brand">
              Home
            </Link>
            <span aria-hidden className="text-ink-faint">/</span>
            <span className="text-ink">Recently sold</span>
          </nav>

          {/* The same box /search has, searching sales instead of listings. */}
          <Suspense fallback={<SearchBarSkeleton />}>
            <SearchBar action="/sold" />
          </Suspense>

          <h1 className="pt-lg text-headline-xl font-display text-ink">
            Recently sold properties {suburb ? `in ${[suburb, state].filter(Boolean).join(', ')}` : ''}
          </h1>

          <div className="mt-sm flex flex-wrap items-center justify-between gap-sm border-b border-line-subtle pb-md">
            <p className="text-body-md text-ink-soft">{summary}</p>
            <SortBar options={sorts} current={currentSort} />
          </div>

          <div className="grid items-start gap-lg pt-lg lg:grid-cols-12">
            <section className="lg:col-span-8">
              <Refreshing>
              {sales.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line px-md py-xl text-center">
                  <p className="text-body-md text-ink">Nothing to show here yet.</p>
                  <p className="mt-1 text-body-sm text-ink-soft">
                    A sale appears once an agency records one against an address.
                  </p>
                  <Link
                    href={forSaleHref}
                    className="mt-md inline-flex items-center justify-center rounded-md bg-brand px-md py-sm text-body-md text-brand-ink transition hover:opacity-90"
                  >
                    See what is for sale now
                  </Link>
                </div>
              ) : (
                <>
                  <ResultsMap pins={pins} unpinned={sales.length - pins.length} />

                  <div className="grid gap-md">
                    {sales.map((sale) => (
                      <SoldResultRow key={sale.listingId} sale={sale} searchedSuburb={suburb} />
                    ))}
                  </div>

                  {pages > 1 ? (
                    <nav
                      aria-label="Pages"
                      className="mt-lg flex items-center justify-center gap-md text-body-sm"
                    >
                      {page > 1 ? (
                        <Link href={hrefFor(page - 1)} rel="prev" className="text-brand hover:underline">
                          ← Previous
                        </Link>
                      ) : (
                        <span className="text-ink-faint">← Previous</span>
                      )}
                      <span className="text-ink-soft">
                        Page {page} of {pages}
                      </span>
                      {page < pages ? (
                        <Link href={hrefFor(page + 1)} rel="next" className="text-brand hover:underline">
                          Next →
                        </Link>
                      ) : (
                        <span className="text-ink-faint">Next →</span>
                      )}
                    </nav>
                  ) : null}
                </>
              )}
              </Refreshing>
            </section>

            <aside className="grid gap-md lg:sticky lg:top-lg lg:col-span-4">
              <Panel title={suburb ? `Buying in ${suburb}?` : 'Buying?'}>
                <div className="grid gap-sm px-md py-sm">
                  <p className="text-body-sm text-ink-soft">
                    These have sold and are not for sale. See what is on the market now
                    {suburb ? ` ${near ? `around ${suburb}` : `in ${suburb}`}` : ''}.
                  </p>
                  <Link
                    href={forSaleHref}
                    prefetch={false}
                    className="inline-flex items-center justify-center rounded-sm bg-brand px-md py-2 text-label-md uppercase text-brand-ink transition hover:bg-brand-deep"
                  >
                    Homes for sale
                  </Link>
                </div>
              </Panel>

              <Panel title="About these sales">
                <p className="px-md py-sm text-body-sm text-ink-soft">
                  This portal only knows the sales its own agencies recorded, so a quiet
                  list does not mean a quiet suburb. Prices are the recorded sale prices.
                </p>
              </Panel>

              <NotConnectedPanel />
            </aside>
          </div>
        </div>
      </div>
      </SortingProvider>
    </WebShell>
  );
}

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

const SOLD_ON = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
