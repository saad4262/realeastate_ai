import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  addressLines,
  channelLabel,
  landLabel,
  listedLabel,
  priceLabel,
  specLine,
} from '@repo/core/listings/format';
import { WebShell } from '../../../components/web-shell';
import { ListingMap } from '../../../components/listing-map';
import {
  AgentPanel,
  Card,
  Inspections,
  NotConnected,
  Timeline,
} from '../../../components/listing-sections';
import {
  cachedAgentCards,
  cachedInspections,
  cachedListing,
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

  // getPublicListing only returns live listings, so a draft or a withdrawn one
  // is a 404 here rather than a partially rendered page.
  if (!listing) notFound();

  /**
   * Four reads, started together.
   *
   * Sequential awaits would make this page four round trips to a database a
   * region away instead of one. The listing itself has to resolve first —
   * nothing else can be asked for without its id and property id — but the
   * other three have no dependency on each other.
   */
  const [inspections, timeline, agents] = await Promise.all([
    cachedInspections(listing.id),
    cachedTimeline(listing.propertyId),
    cachedAgentCards(listing.id),
  ]);

  const { street, locality } = addressLines(listing);
  const specs = [
    listing.bedrooms !== null ? { label: 'Bed', value: String(listing.bedrooms) } : null,
    listing.bathrooms !== null ? { label: 'Bath', value: String(listing.bathrooms) } : null,
    listing.carSpaces !== null ? { label: 'Car', value: String(listing.carSpaces) } : null,
    landLabel(listing.landAreaSqm)
      ? { label: 'Land', value: landLabel(listing.landAreaSqm) as string }
      : null,
    listing.propertyType
      ? { label: 'Type', value: listing.propertyType.replace(/^./, (c) => c.toUpperCase()) }
      : null,
  ].filter((s): s is { label: string; value: string } => s !== null);

  const listed = listedLabel(listing.publishedAt);

  return (
    <WebShell wide>
      <div className="mx-auto w-full max-w-[1200px] px-gutter pb-xl">
        {/*
          Breadcrumbs, replacing a bare "back to search".
          Every link here is a real search this site can run, built from the
          row — which is also what makes them useful internal links rather
          than decoration. The old back link always landed on an unfiltered
          /search, losing whatever search the visitor arrived from.
        */}
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-2 gap-y-1 py-md text-body-sm text-ink-soft">
          <Link href="/" className="hover:text-brand">
            Home
          </Link>
          <span aria-hidden className="text-ink-faint">/</span>
          <Link href={`/search?state=${encodeURIComponent(listing.state)}`} className="hover:text-brand">
            {listing.state}
          </Link>
          <span aria-hidden className="text-ink-faint">/</span>
          <Link
            href={`/search?suburb=${encodeURIComponent(listing.suburb)}&state=${encodeURIComponent(listing.state)}`}
            className="hover:text-brand"
          >
            {listing.suburb} {listing.postcode}
          </Link>
          <span aria-hidden className="text-ink-faint">/</span>
          <span className="truncate text-ink">{street}</span>
        </nav>

        {/*
          The media slot.

          Structured as a frame with the gradient as an absolutely positioned
          child rather than as a background on the frame itself, so a real
          photo drops in as a sibling without the page's grid moving. The
          `media` table exists; there is no upload path or R2 credential yet.
        */}
        <div className="relative overflow-hidden rounded-lg border border-line-subtle">
          <div className="aspect-[16/7] w-full bg-gradient-to-br from-brand to-[#14624a]" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
            <span className="text-headline-lg font-display text-white/90">{listing.suburb}</span>
            <span className="text-label-sm uppercase text-white/60">No photos yet</span>
          </div>
          <span className="absolute left-md top-md rounded-sm bg-canvas/90 px-2 py-1 text-label-sm uppercase text-brand backdrop-blur">
            {channelLabel(listing.channel)}
          </span>
        </div>

        <div className="mt-lg grid items-start gap-lg lg:grid-cols-12">
          {/* ------------------------------------------------ main column -- */}
          <div className="grid gap-lg lg:col-span-8">
            <div className="rounded-lg border border-line-subtle bg-card p-lg shadow-card sm:p-margin">
              <div className="text-headline-xl font-display text-ink">{priceLabel(listing)}</div>
              <h1 className="mt-sm text-headline-md text-ink">{street}</h1>
              <p className="text-body-md text-ink-soft">{locality}</p>
              {listed ? <p className="mt-1 text-body-sm text-ink-faint">{listed}</p> : null}

              {specs.length > 0 ? (
                <dl className="mt-md grid grid-cols-2 gap-sm rounded-md bg-canvas p-md sm:grid-cols-5">
                  {specs.map((s) => (
                    <div key={s.label}>
                      <dd className="text-headline-md font-display text-ink">{s.value}</dd>
                      <dt className="text-label-sm uppercase text-ink-faint">{s.label}</dt>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>

            {listing.headline || listing.description ? (
              <Card title="About this property">
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

            <Inspections inspections={inspections} />

            {listing.latitude !== null && listing.longitude !== null ? (
              <Card id="map" title="Where it is">
                <ListingMap
                  latitude={listing.latitude}
                  longitude={listing.longitude}
                  label={listing.address}
                />
              </Card>
            ) : null}

            <Timeline entries={timeline} currentListingId={listing.id} />

            {/*
              Sections this platform has no data source for. Said in one line
              each rather than drawn as convincing empty panels — see
              NotConnected. Six full-height "coming soon" blocks would make a
              working page read as broken, and a plausible-looking median would
              be the invented number #4 exists to forbid.
            */}
            <Card title="Not connected yet" note="Shown so it is clear what is missing, rather than left out.">
              <div className="grid gap-sm">
                <NotConnected title="Photos & floorplan" what="no media pipeline is configured" />
                <NotConnected title="Features & inclusions" what="not captured when a listing is created" />
                <NotConnected title="Energy rating" what="not captured" />
                <NotConnected title="Market insights" what="no market data source is connected" />
                <NotConnected title="Schools & catchment" what="no schools data source is connected" />
              </div>
            </Card>
          </div>

          {/* --------------------------------------------- sticky sidebar -- */}
          <aside className="grid gap-lg lg:col-span-4 lg:sticky lg:top-lg">
            <AgentPanel agents={agents} agencyName={listing.agencyName} />
          </aside>
        </div>
      </div>
    </WebShell>
  );
}
