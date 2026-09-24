import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@repo/ui';
import { ListingMap } from '../../../components/listing-map';
import { priceLabel, specLine } from '../../../components/listing-card';
import { cachedListing } from '../../../lib/cached';
import styles from './listing.module.css';

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
    <AppShell surface="web">
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
    </AppShell>
  );
}
