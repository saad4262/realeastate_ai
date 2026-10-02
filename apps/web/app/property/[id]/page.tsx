import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { landLabel } from '@repo/core/listings/format';
import { WebShell } from '../../../components/web-shell';
import { currentWebUser } from '../../../lib/session';
import { ListingMap } from '../../../components/listing-map';
import { OfferLink, PrivateOfferForm } from '../../../components/private-offer-form';
import {
  AgentPanel,
  Card,
  Chip,
  DueDiligence,
  NotConnected,
  SpecBar,
  Timeline,
  type SpecTile,
} from '../../../components/listing-sections';
import { Icon } from '../../../components/icons';
import { ListingMedia } from '../../../components/listing-card';
import { portalFonts } from '../../portal-fonts';
import {
  cachedAgentCards,
  cachedListingPhotos,
  cachedLiveListingId,
  cachedOffMarketProperty,
  cachedTimeline,
} from '../../../lib/cached';

/**
 * An address that is not for sale.
 *
 * The first public route on this site keyed by a PROPERTY rather than by a
 * listing: the page for an address with no live ad, carrying its sale history
 * and the private offer that goes to whoever sold it last (ADR 0012). Once the
 * address is listed again it hands off to that listing, which shows the same
 * history (ADR 0013) — so one house never has two pages competing for it.
 *
 * `force-dynamic`, for two reasons that each suffice. It reads the session to
 * decide whether to offer the form, which a cached route cannot do. And
 * `notFound()` on this site answers HTTP 200 because the shell streams before
 * the body runs — caching a wrong status makes it stick, which is the same
 * reasoning written out at length on the listing page.
 */
export const dynamic = 'force-dynamic';

/**
 * Not indexed, and that is a product decision rather than an SEO one.
 *
 * The page is reachable by anyone with the link; it is simply not advertised.
 * Nothing in /search points here, there is no sitemap entry, and `noindex`
 * keeps a crawler from building a public directory of recently-sold addresses
 * and the offers they might attract. A visitor who has the URL is someone who
 * was given it.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const property = await cachedOffMarketProperty((await params).id);
  const robots = { index: false, follow: false };

  if (!property) return { title: 'Property not found — Property Platform', robots };
  return {
    title: `${property.address} — Property Platform`,
    description: `Sale history for ${property.address}. Not currently on the market.`,
    robots,
  };
}

export default async function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const propertyId = (await params).id;

  /**
   * The gate first, alone, because everything else depends on the answer.
   *
   * It returns null for three different states — on the market, never publicly
   * listed, or no such property. One of them has somewhere better to be: an
   * address re-listed since goes to its live listing, which carries the same
   * history and whose enquiry reaches the agency selling it now (ADR 0013).
   * That reveals nothing — a live listing is public. The rest stay one 404, so
   * somebody feeding uuids in cannot tell an unpublished draft or an
   * under-offer address from no property at all.
   */
  const property = await cachedOffMarketProperty(propertyId);
  if (!property) {
    const liveId = await cachedLiveListingId(propertyId);
    if (liveId) redirect(`/listing/${liveId}`);
    notFound();
  }

  /**
   * Then the two that do not depend on each other, started together.
   *
   * `currentWebUser` reads the middleware header, which means this route has to
   * be in the matcher — see apps/web/middleware.ts. Without it this is silently
   * null for a signed-in visitor and the offer form shows a sign-in prompt to
   * somebody already signed in.
   */
  const [timeline, user] = await Promise.all([cachedTimeline(propertyId), currentWebUser()]);

  /**
   * The campaign this page is about: the last one, which is the sale when there
   * was one. Ordered by HISTORY_ORDER already — the same row createPrivateOffer
   * routes an offer to, so the agency on screen is the agency that gets it.
   *
   * Its photos and agents are what the gallery and the sidebar draw, read by
   * listing id. The id came out of the timeline, which only ever holds
   * campaigns the public was allowed to see — so no draft's photos can arrive
   * here by this route.
   */
  const last = timeline.find((e) => e.status === 'sold' && e.soldPrice !== null) ?? timeline[0];
  const [photos, agents] = last
    ? await Promise.all([cachedListingPhotos(last.listingId), cachedAgentCards(last.listingId)])
    : [[], []];

  // Formatted here, from SQL's figures (#4), as every sold price on the site is.
  const soldPrice = last?.soldPrice != null ? AUD.format(last.soldPrice) : null;
  const soldOn = last?.soldDate ? SOLD_ON.format(new Date(last.soldDate)) : null;

  const street = property.address.replace(
    `, ${property.suburb}, ${property.state} ${property.postcode}`,
    '',
  );
  const locality = `${property.suburb}, ${property.state} ${property.postcode}`;
  const media = {
    id: last?.listingId ?? property.id,
    mainPhotoKey: last?.mainPhotoKey ?? null,
    address: property.address,
    suburb: property.suburb,
  };

  const specs: SpecTile[] = (
    [
      property.bedrooms !== null
        ? { icon: 'bed', value: String(property.bedrooms), label: 'Bedrooms' }
        : null,
      property.bathrooms !== null
        ? { icon: 'bath', value: String(property.bathrooms), label: 'Bathrooms' }
        : null,
      property.carSpaces !== null
        ? { icon: 'car', value: String(property.carSpaces), label: 'Car spaces' }
        : null,
      landLabel(property.landAreaSqm)
        ? { icon: 'ruler', value: landLabel(property.landAreaSqm) as string, label: 'Land size' }
        : null,
      property.propertyType
        ? {
            icon: 'home',
            value: property.propertyType.replace(/^./, (c) => c.toUpperCase()),
            label: 'Type',
          }
        : null,
    ] as (SpecTile | null)[]
  ).filter((t): t is SpecTile => t !== null);

  const hasMap = property.latitude !== null && property.longitude !== null;

  /** The listing page's tab bar, built from the sections that rendered. */
  const tabs = [
    { href: '#overview', label: 'Overview' },
    timeline.length ? { href: '#history', label: 'Property history' } : null,
    hasMap ? { href: '#map', label: 'Location' } : null,
    { href: '#offer', label: 'Make an offer' },
  ].filter((t): t is { href: string; label: string } => t !== null);

  return (
    <WebShell wide account={{ signedIn: Boolean(user) }}>
      {/*
        The /listing/[id] layout, deliberately: gallery, strip, sticky bar,
        price card, sidebar. A visitor should not learn a second detail page.
        What differs is what must: SOLD where the channel was, the sold price
        where the guide was, the history section, and an offer instead of an
        enquiry.
      */}
      <div
        data-skin="portal"
        data-page="property-detail"
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
            <Link
              href={`/search?state=${encodeURIComponent(property.state)}`}
              className="text-ink-soft hover:text-brand"
            >
              {property.state}
            </Link>
            <span aria-hidden className="text-ink-faint">/</span>
            {/* A real search, so the visitor has somewhere to go that IS on the
                market — which is the one thing this page cannot offer them. */}
            <Link
              href={`/search?suburb=${encodeURIComponent(property.suburb)}&state=${encodeURIComponent(property.state)}`}
              className="text-ink-soft hover:text-brand"
            >
              {property.suburb} {property.postcode}
            </Link>
            <span aria-hidden className="text-ink-faint">/</span>
            <span className="truncate text-ink">{street}</span>
          </nav>

          <div className="grid gap-2 overflow-hidden rounded-xl sm:grid-cols-3 sm:grid-rows-2">
            <ListingMedia
              listing={media}
              photoKey={photos[0]?.storageKey ?? media.mainPhotoKey}
              alt={photos[0]?.caption ?? `${street}, ${property.suburb}`}
              sizes="(max-width: 640px) 100vw, 66vw"
              priority
              className="aspect-[16/10] sm:col-span-2 sm:row-span-2 sm:aspect-auto sm:h-full sm:min-h-[22rem]"
            >
              <div className="absolute left-md top-md flex flex-wrap gap-1.5">
                <span className="rounded-sm bg-ink/80 px-2 py-1 text-label-sm uppercase text-white backdrop-blur-sm">
                  {soldPrice ? 'Sold' : 'Off market'}
                </span>
              </div>
            </ListingMedia>

            <ListingMedia
              listing={media}
              photoKey={photos[1]?.storageKey ?? null}
              alt={photos[1]?.caption ?? `${street} — photo 2`}
              sizes="(max-width: 640px) 100vw, 33vw"
              className="hidden aspect-[4/3] sm:block"
            />

            <ListingMedia
              listing={media}
              photoKey={photos[2]?.storageKey ?? null}
              alt={photos[2]?.caption ?? `${street} — photo 3`}
              sizes="(max-width: 640px) 100vw, 33vw"
              className="hidden aspect-[4/3] sm:block"
            >
              {photos.length > 3 ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-ink/55 text-center text-white backdrop-blur-[2px]">
                  <Icon name="gallery" className="size-6" />
                  <span className="font-display text-headline-md leading-none">
                    +{photos.length - 3}
                  </span>
                  <span className="text-label-sm uppercase tracking-wide">more photos</span>
                </div>
              ) : photos.length === 0 ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-ink/55 text-center text-white backdrop-blur-[2px]">
                  <Icon name="gallery" className="size-6" />
                  <span className="font-display text-headline-md leading-none">0</span>
                  <span className="text-label-sm uppercase tracking-wide">photos</span>
                </div>
              ) : null}
            </ListingMedia>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-sm py-sm">
            <div className="flex flex-wrap items-center gap-sm">
              {/*
                Said first, as on the listing page's "Live listing". A visitor
                arriving from a link has no way to know this is not an ad, and
                a page that looks like one for a house nobody is selling is the
                one misreading that matters here.
              */}
              <Chip icon="verified" tone="neutral">
                Not currently on the market
              </Chip>
              {photos.length ? (
                <Chip icon="gallery">
                  {photos.length} {photos.length === 1 ? 'photo' : 'photos'}
                </Chip>
              ) : null}
              {hasMap ? (
                <a href="#map" className="text-body-sm text-ink-soft hover:text-brand">
                  <Chip icon="pin">On the map</Chip>
                </a>
              ) : null}
            </div>
            {soldOn ? (
              <span className="text-label-sm uppercase text-ink-faint">Sold {soldOn}</span>
            ) : null}
          </div>

          <div className="sticky top-16 z-30 -mx-gutter mb-lg border-y border-line-subtle bg-card px-gutter shadow-card">
            <div className="flex items-center justify-between gap-md overflow-x-auto">
              <nav aria-label="On this page" className="flex h-12 items-center gap-lg whitespace-nowrap">
                {tabs.map((t) =>
                  t.href === '#offer' ? (
                    <OfferLink
                      key={t.href}
                      className="flex h-full items-center text-body-sm text-ink-soft transition-colors hover:text-ink"
                    >
                      {t.label}
                    </OfferLink>
                  ) : (
                    <a
                      key={t.href}
                      href={t.href}
                      className="flex h-full items-center text-body-sm text-ink-soft transition-colors hover:text-ink"
                    >
                      {t.label}
                    </a>
                  ),
                )}
              </nav>
              <div className="hidden shrink-0 items-center gap-sm lg:flex">
                {soldPrice ? (
                  <span className="font-display text-headline-md text-ink">Sold {soldPrice}</span>
                ) : null}
                <OfferLink className="rounded-lg bg-brand px-md py-1.5 text-body-sm text-brand-ink transition hover:bg-brand-deep">
                  Make an offer
                </OfferLink>
              </div>
            </div>
          </div>

          <div className="grid items-start gap-lg lg:grid-cols-12">
            <div className="grid gap-lg lg:col-span-8">
              <section
                id="overview"
                className="scroll-mt-28 rounded-xl border border-line-subtle bg-card p-lg shadow-card sm:p-margin"
              >
                <div className="flex flex-wrap items-start justify-between gap-sm">
                  <div>
                    <p className="text-label-sm uppercase tracking-wide text-brand">
                      {soldPrice ? `Last sold${soldOn ? ` · ${soldOn}` : ''}` : 'Not on the market'}
                    </p>
                    <h1 className="font-display text-headline-xl text-ink">
                      {soldPrice ?? street}
                    </h1>
                  </div>
                  <Chip tone="neutral">{soldPrice ? 'Sold' : 'Off market'}</Chip>
                </div>

                <div className="mt-sm">
                  <h2 className="font-display text-headline-md text-ink">{street}</h2>
                  <p className="text-body-md text-ink-soft">{locality}</p>
                </div>

                {specs.length > 0 ? (
                  <div className="mt-md">
                    <SpecBar specs={specs} />
                  </div>
                ) : null}

                <p className="mt-md text-body-sm text-ink-soft">
                  This address has no current listing. Below is its sale history,
                  taken from the ads written against it.
                </p>
              </section>

              {/* The history this page exists for — the one section the listing
                  page never shows. No `currentListingId`: nothing here is on
                  the market, so every entry is worth showing. */}
              <Timeline entries={timeline} />

              {hasMap ? (
                <Card
                  id="map"
                  eyebrow="Local neighbourhood"
                  title={`${property.suburb}, ${property.state} ${property.postcode}`}
                >
                  <ListingMap
                    latitude={property.latitude as number}
                    longitude={property.longitude as number}
                    label={property.address}
                  />
                </Card>
              ) : null}

              <Card
                eyebrow="Not connected"
                title="What this page cannot show yet"
                note="Listed so it is clear what is missing, rather than left out or filled in."
              >
                <div className="grid gap-sm">
                  <NotConnected title="Market insights" what="no market data source is connected" />
                  <NotConnected title="Estimated value" what="this platform does not estimate values" />
                  <NotConnected title="Schools & catchment" what="no schools data source is connected" />
                </div>
              </Card>

              <DueDiligence state={property.state} />
            </div>

            <aside className="grid gap-lg lg:sticky lg:top-32 lg:col-span-4">
              {last ? <AgentPanel agents={agents} agencyName={last.agencyName} sold /> : null}
              <PrivateOfferForm
                propertyId={property.id}
                propertyAddress={property.address}
                signedIn={Boolean(user)}
              />
            </aside>
          </div>
        </div>
      </div>
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
