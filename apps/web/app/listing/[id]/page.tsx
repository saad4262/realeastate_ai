import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { WebShell } from '../../../components/web-shell';
import { ListingMap } from '../../../components/listing-map';
import { priceLabel, specLine } from '../../../components/listing-card';
import { cachedListing } from '../../../lib/cached';
import styles from './listing.module.css';

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
 * with force-dynamic, and with this app's own not-found.tsx removed entirely;
 * dev returns a correct 404 and production does not. It is a soft 404 on the
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

  return (
    <WebShell>
      <article className={styles.wrap}>
        <Link href="/search" className={styles.back}>
          ← Back to search
        </Link>

        <div className={styles.hero} aria-hidden>
          <span className={styles.heroText}>{listing.suburb}</span>
        </div>

        <header className={styles.head}>
          <div>
            <h1 className={styles.address}>{listing.address}</h1>
            {specLine(listing) ? <p className={styles.specs}>{specLine(listing)}</p> : null}
          </div>
          <div className={styles.price}>{priceLabel(listing)}</div>
        </header>

        {listing.headline ? <h2 className={styles.headline}>{listing.headline}</h2> : null}

        {/* Only when the property has actually been pinned. A map centred on a
            suburb because the pin is missing says the house is somewhere it is
            not, which is worse than no map. */}
        <ListingMap
          latitude={listing.latitude}
          longitude={listing.longitude}
          label={listing.address}
        />

        {listing.description ? (
          <div className={styles.description}>
            {listing.description.split(/\n{2,}/).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        ) : null}

        <section className={styles.facts}>
          <h3 className={styles.factsTitle}>Property</h3>
          <dl className={styles.factGrid}>
            {[
              ['Type', listing.propertyType],
              ['Bedrooms', listing.bedrooms],
              ['Bathrooms', listing.bathrooms],
              ['Car spaces', listing.carSpaces],
              ['Suburb', listing.suburb],
              ['Postcode', listing.postcode],
            ]
              .filter(([, v]) => v !== null && v !== undefined && v !== '')
              .map(([label, value]) => (
                <div key={String(label)} className={styles.fact}>
                  <dt>{label}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
          </dl>
        </section>

        <section className={styles.agents}>
          <h3 className={styles.factsTitle}>Marketed by</h3>
          <p className={styles.agency}>{listing.agencyName}</p>
          {listing.agents.length ? (
            <ul className={styles.agentList}>
              {listing.agents.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          ) : null}
        </section>
      </article>
    </WebShell>
  );
}
