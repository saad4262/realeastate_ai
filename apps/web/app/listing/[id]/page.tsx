import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  addressLines,
  channelLabel,
  landLabel,
  listedLabel,
  priceLabel,
  specLine,
} from '@repo/core/listings/format';
import { WebShell } from '../../../components/web-shell';
import { looksSignedIn } from '../../../lib/session';
import { ListingMap } from '../../../components/listing-map';
import { EnquiryForm } from '../../../components/enquiry-form';
import {
  AgentPanel,
  Timeline,
  usefulTimeline,
  Card,
  Chip,
  DueDiligence,
  Inspections,
  NotConnected,
  SpecBar,
  type SpecTile,
} from '../../../components/listing-sections';
import { Icon } from '../../../components/icons';
import { ListingMedia } from '../../../components/listing-card';
import { portalFonts } from '../../portal-fonts';
import {
  cachedAgentCards,
  cachedInspections,
  cachedListing,
  cachedFormerListingDestination,
  cachedListingPhotos,
  cachedTimeline,
} from '../../../lib/cached';

/**
 * Rendered per request, deliberately, and not for the reason it first looked.
 *
 * Caching this route works. It was measured end to end on a production build:
 *
 *     1st request                         x-nextjs-cache: MISS
 *     2nd, 3rd                            x-nextjs-cache: HIT
 *     after revalidateTag('listing:<id>') x-nextjs-cache: MISS
 *
 * so the console's existing publish -> revalidateWeb -> /api/revalidate chain
 * does invalidate the cached PAGE, not just the row behind it. If this is
 * re-enabled, note that `generateStaticParams` returning [] is REQUIRED — not
 * optional and not merely a build-time hint. Without it the route never enters
 * dynamicRoutes and every request re-renders whatever `revalidate` says.
 *
 * What stopped it is the 404. getPublicListing returns null for a draft, a
 * withdrawn listing or a bad id, so notFound() runs — and in production this
 * route answers it with HTTP 200 and the not-found body:
 *
 *     /listing/<unknown-id>   HTTP/1.1 200 OK
 *     /nope                   HTTP/1.1 404 Not Found
 *
 * That is PRE-EXISTING, not caused by caching. It reproduces on a clean build
 * with force-dynamic, and with this app's own not-found.tsx removed entirely.
 *
 * An earlier version of this note said dev returned a correct 404 and only
 * production did not. Re-measured against the committed code before this page
 * was rewritten: dev answers 200 as well. The cause is streaming — the shell
 * flushes, and with it the status line, before the component body runs
 * notFound() — so it follows the loading.tsx boundary rather than the
 * environment. It is a soft 404 on the
 * one page search engines index, and a withdrawn listing is a link people have
 * already shared.
 *
 * Caching does not create that bug but it does make it stick: a wrong status
 * served from a cache is worse than a wrong status served fresh. So the win is
 * left on the table until the status is fixed, which is a separate piece of
 * work. The cost of waiting is small — cachedListing already holds the row for
 * 60 s behind its tag, so a request here costs a render, not a round trip to
 * the database region.
 */
export const dynamic = 'force-dynamic';

/**
 * Cached per listing id and tagged the same way, so editing one listing clears
 * that page and nothing else. generateMetadata and the page body both call
 * this; React's own request cache makes that one lookup, not two.
 */
const load = cachedListing;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const listing = await load((await params).id);
  if (!listing) return { title: 'Listing not found — Property Platform' };
  return {
    title: `${listing.address} — Property Platform`,
    description: listing.headline ?? `${specLine(listing)} in ${listing.suburb}.`,
  };
}

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const listing = await load((await params).id);

  // getPublicListing only returns live listings. An ad that WAS public — sold,
  // under offer, withdrawn — sends an old bookmark on to wherever the address
  // lives now: its new listing, or its history page. A draft or a bad id is
  // still a 404, so a guessed id confirms nothing.
  if (!listing) {
    const destination = await cachedFormerListingDestination((await params).id);
    if (destination) redirect(destination);
    notFound();
  }

  /**
   * Five reads, started together.
   *
   * Sequential awaits would make this page several round trips to a database a
   * region away instead of one. The listing itself has to resolve first —
   * nothing else can be asked for without its id — but the rest have no
   * dependency on each other.
   *
   * The property's history is among them again. It was left out while the
   * rule was "hide what a house last sold for while it is on the market"
   * (ADR 0012); the client asked for the portal-standard behaviour instead —
   * a re-listed house shows every earlier sale, by whichever agency made it —
   * which is ADR 0013. Keyed by the PROPERTY, so a listing written by a new
   * agency shows the sales other agencies recorded at the same address.
   */
  const [inspections, agents, photos, signedIn, timeline] = await Promise.all([
    cachedInspections(listing.id),
    cachedAgentCards(listing.id),
    cachedListingPhotos(listing.id),
    // A cookie sniff, not a session: this route is outside the middleware
    // matcher. It reads no network and only decides which header link to
    // draw — see looksSignedIn().
    looksSignedIn(),
    cachedTimeline(listing.propertyId),
  ]);
  // The same filter the section uses, so the tab never scrolls to nothing.
  const hasHistory = usefulTimeline(timeline, listing.id).length > 0;

  const { street, locality } = addressLines(listing);

  /**
   * The mock's key specification bar, in its order: beds, baths, car, land,
   * type. Each tile is dropped rather than zeroed when the column is null — a
   * property with no recorded land size is not a property on 0 m².
   */
  const specs: SpecTile[] = (
    [
      listing.bedrooms !== null
        ? { icon: 'bed', value: String(listing.bedrooms), label: 'Bedrooms' }
        : null,
      listing.bathrooms !== null
        ? { icon: 'bath', value: String(listing.bathrooms), label: 'Bathrooms' }
        : null,
      listing.carSpaces !== null
        ? { icon: 'car', value: String(listing.carSpaces), label: 'Car spaces' }
        : null,
      landLabel(listing.landAreaSqm)
        ? { icon: 'ruler', value: landLabel(listing.landAreaSqm) as string, label: 'Land size' }
        : null,
      listing.propertyType
        ? {
            icon: 'home',
            value: listing.propertyType.replace(/^./, (c) => c.toUpperCase()),
            label: 'Type',
          }
        : null,
    ] as (SpecTile | null)[]
  ).filter((t): t is SpecTile => t !== null);

  const listed = listedLabel(listing.publishedAt);
  const price = priceLabel(listing);
  const hasMap = listing.latitude !== null && listing.longitude !== null;

  /**
   * The in-page tab bar, built from the sections that actually rendered.
   *
   * The mock's bar is fixed — Overview, Inspection Times, Features, Floorplan,
   * Market Insights, Suburb Profile — because its page always has all six. On
   * this platform a listing may have no inspections, no history and no
   * coordinates, and a tab that scrolls to nothing is worse than one fewer
   * tab.
   */
  const tabs = [
    { href: '#overview', label: 'Overview' },
    inspections.length ? { href: '#inspections', label: 'Inspection times' } : null,
    listing.description || listing.headline ? { href: '#about', label: 'About' } : null,
    hasHistory ? { href: '#history', label: 'Property history' } : null,
    hasMap ? { href: '#map', label: 'Location' } : null,
    { href: '#enquire', label: 'Contact agent' },
  ].filter((t): t is { href: string; label: string } => t !== null);

  return (
    <WebShell wide account={{ signedIn }}>
      {/*
        The portal skin, and the mock's two families with it.

        Same wrapper as /search, so the two public pages are one design rather
        than two that happen to share a palette. data-page marks this element
        as the page's own — loading.tsx carries the skin too, and its shell
        streams into the same response, so "is data-skin anywhere in the HTML"
        is a question the skeleton can answer on its own. It did, once.
      */}
      <div
        data-skin="portal"
        data-page="listing-detail"
        className={`${portalFonts} min-h-screen bg-canvas`}
      >
        <div className="mx-auto w-full max-w-[1200px] px-gutter pb-xl">
          {/*
            Breadcrumbs, replacing a bare "back to search".
            Every link here is a real search this site can run, built from the
            row — which is also what makes them useful internal links rather
            than decoration. The old back link always landed on an unfiltered
            /search, losing whatever search the visitor arrived from.
          */}
          <nav
            aria-label="Breadcrumb"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 py-md text-body-sm text-ink-soft"
          >
            <Link href="/" className="text-ink-soft hover:text-brand">
              Home
            </Link>
            <span aria-hidden className="text-ink-faint">/</span>
            <Link
              href={`/search?state=${encodeURIComponent(listing.state)}`}
              className="text-ink-soft hover:text-brand"
            >
              {listing.state}
            </Link>
            <span aria-hidden className="text-ink-faint">/</span>
            <Link
              href={`/search?suburb=${encodeURIComponent(listing.suburb)}&state=${encodeURIComponent(listing.state)}`}
              className="text-ink-soft hover:text-brand"
            >
              {listing.suburb} {listing.postcode}
            </Link>
            <span aria-hidden className="text-ink-faint">/</span>
            <span className="truncate text-ink">{street}</span>
          </nav>

          {/*
            The gallery: the mock's one-large-plus-two grid.

            Built for photos that did not exist when it was written, which is
            why adding them changed nothing here except which props go in.
            Each tile is a ListingMedia frame, and that component decides on
            its own whether it has a photo to draw or a gradient to fall back
            to — so a listing with one photo, three photos or none all render
            through the same three tiles.

            The hero is `priority`: it is the largest image above the fold on
            this page and the one the LCP is measured against.
          */}
          <div className="grid gap-2 overflow-hidden rounded-xl sm:grid-cols-3 sm:grid-rows-2">
            <ListingMedia
              listing={listing}
              photoKey={photos[0]?.storageKey ?? null}
              alt={photos[0]?.caption ?? `${street}, ${listing.suburb}`}
              sizes="(max-width: 640px) 100vw, 66vw"
              priority
              className="aspect-[16/10] sm:col-span-2 sm:row-span-2 sm:aspect-auto sm:h-full sm:min-h-[22rem]"
            >
              {/* One badge, and it is a status. The mock's second badge says
                  "UNDER OFFER REVIEW" — a state. A listing date in the same
                  crimson reads as one too, so it moved to the strip below. */}
              <div className="absolute left-md top-md flex flex-wrap gap-1.5">
                <span className="rounded-sm bg-ink/80 px-2 py-1 text-label-sm uppercase text-white backdrop-blur-sm">
                  {channelLabel(listing.channel)}
                </span>
              </div>
            </ListingMedia>

            <ListingMedia
              listing={listing}
              photoKey={photos[1]?.storageKey ?? null}
              alt={photos[1]?.caption ?? `${street} — photo 2`}
              sizes="(max-width: 640px) 100vw, 33vw"
              className="hidden aspect-[4/3] sm:block"
            />

            <ListingMedia
              listing={listing}
              photoKey={photos[2]?.storageKey ?? null}
              alt={photos[2]?.caption ?? `${street} — photo 3`}
              sizes="(max-width: 640px) 100vw, 33vw"
              className="hidden aspect-[4/3] sm:block"
            >
              {/*
                The count, over the third tile, as the mock does it.

                It says what is actually there. With no photos it reads "0
                photos yet" rather than a "24 photos" badge that would be a
                lie; with more than three it says how many more there are, and
                below that it stays out of the way so the third photo is
                visible.
              */}
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
                  <span className="text-label-sm uppercase tracking-wide">photos yet</span>
                </div>
              ) : null}
            </ListingMedia>
          </div>

          {/*
            The media strip under the gallery.

            The mock puts four chips here — Interactive Floorplan, HD Video
            Walkthrough, Statement of Information Verified, Listing ID. Three
            of them assert things this platform cannot: there is no floorplan,
            no video, and nothing verifies a Statement of Information. The one
            that is true is the listing id, so it is the one that is drawn.
          */}
          <div className="flex flex-wrap items-center justify-between gap-sm py-sm">
            <div className="flex flex-wrap items-center gap-sm">
              <Chip icon="verified" tone="success">
                Live listing
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
            <span className="flex flex-wrap items-center gap-md text-label-sm uppercase text-ink-faint">
              {listed ? <span>{listed}</span> : null}
              <span>
                Listing ID{' '}
                <span className="tabular-nums text-ink-soft">{listing.id.slice(0, 8)}</span>
              </span>
            </span>
          </div>

          {/*
            The sticky in-page bar.

            `top-16` rather than the mock's `top-28`: AppShell's header is this
            site's, not the mock's, and it is the other sticky element on the
            page. Anything that scrolls to an anchor needs the `scroll-mt-28`
            that Card sets, or every heading lands underneath this bar.

            Anchors, not tabs — no JavaScript, works from a shared link, and
            the browser's own scrolling is smoother than anything this would
            reimplement.
          */}
          <div className="sticky top-16 z-30 -mx-gutter mb-lg border-y border-line-subtle bg-card px-gutter shadow-card">
            <div className="flex items-center justify-between gap-md overflow-x-auto">
              <nav aria-label="On this page" className="flex h-12 items-center gap-lg whitespace-nowrap">
                {tabs.map((t) => (
                  <a
                    key={t.href}
                    href={t.href}
                    className="flex h-full items-center text-body-sm text-ink-soft transition-colors hover:text-ink"
                  >
                    {t.label}
                  </a>
                ))}
              </nav>
              <div className="hidden shrink-0 items-center gap-sm lg:flex">
                <span className="font-display text-headline-md text-ink">{price}</span>
                <a
                  href="#enquire"
                  className="rounded-lg bg-brand px-md py-1.5 text-body-sm text-brand-ink transition hover:bg-brand-deep"
                >
                  Enquire
                </a>
              </div>
            </div>
          </div>

          <div className="grid items-start gap-lg lg:grid-cols-12">
            {/* ------------------------------------------------ main column -- */}
            <div className="grid gap-lg lg:col-span-8">
              {/* The price card. The mock leads with the guide label, then the
                  figure, then the address — price first, because that is the
                  question a listing page is opened to answer. */}
              <section
                id="overview"
                className="scroll-mt-28 rounded-xl border border-line-subtle bg-card p-lg shadow-card sm:p-margin"
              >
                <div className="flex flex-wrap items-start justify-between gap-sm">
                  <div>
                    <p className="text-label-sm uppercase tracking-wide text-brand">
                      {listing.channel === 'rent' ? 'Rental guide' : 'Price guide'}
                    </p>
                    <h1 className="font-display text-headline-xl text-ink">{price}</h1>
                  </div>
                  <Chip tone="neutral">{channelLabel(listing.channel)}</Chip>
                </div>

                <div className="mt-sm">
                  <h2 className="font-display text-headline-md text-ink">{street}</h2>
                  <p className="text-body-md text-ink-soft">{locality}</p>
                </div>

                <div className="mt-md">
                  <SpecBar specs={specs} />
                </div>
              </section>

              <Inspections inspections={inspections} />

              {listing.headline || listing.description ? (
                <Card id="about" eyebrow="Property description" title="About this property">
                  {listing.headline ? (
                    <h3 className="mb-sm text-title-sm text-ink">{listing.headline}</h3>
                  ) : null}
                  {listing.description ? (
                    <div className="grid gap-sm text-body-lg leading-relaxed text-ink-soft">
                      {listing.description.split(/\n{2,}/).map((para, i) => (
                        <p key={i}>{para}</p>
                      ))}
                    </div>
                  ) : null}
                </Card>
              ) : null}

              {/* Earlier sales at this address, by any agency. Drops itself when
                  the only entry is this listing. */}
              <Timeline entries={timeline} currentListingId={listing.id} />

              {hasMap ? (
                <Card id="map" eyebrow="Local neighbourhood" title={`${listing.suburb}, ${listing.state} ${listing.postcode}`}>
                  <ListingMap
                    latitude={listing.latitude as number}
                    longitude={listing.longitude as number}
                    label={listing.address}
                  />
                </Card>
              ) : null}

              {/*
                Sections this platform has no data source for. Said in one line
                each rather than drawn as convincing empty panels — see
                NotConnected. Six full-height "coming soon" blocks would make a
                working page read as broken, and a plausible-looking median
                would be the invented number #4 exists to forbid.
              */}
              <Card
                eyebrow="Not connected"
                title="What this page cannot show yet"
                note="Listed so it is clear what is missing, rather than left out or filled in."
              >
                <div className="grid gap-sm">
                  <NotConnected title="Floorplan" what="the media pipeline stores photos, not floorplans, yet" />
                  <NotConnected title="Features & inclusions" what="not captured when a listing is created" />
                  <NotConnected title="Energy rating" what="not captured" />
                  <NotConnected title="Market insights" what="no market data source is connected" />
                  <NotConnected title="Schools & catchment" what="no schools data source is connected" />
                </div>
              </Card>

              <DueDiligence state={listing.state} />
            </div>

            {/* --------------------------------------------- sticky sidebar --
                `top-32` clears both the site header and the in-page bar above
                it. `items-start` on the grid is what lets it stick at all — a
                stretched grid item is as tall as the column beside it, and a
                sticky element inside something that tall never has anywhere to
                stick to. */}
            <aside className="grid gap-lg lg:sticky lg:top-32 lg:col-span-4">
              <AgentPanel agents={agents} agencyName={listing.agencyName} />
              <EnquiryForm listingId={listing.id} agencyName={listing.agencyName} />
            </aside>
          </div>
        </div>
      </div>
    </WebShell>
  );
}
