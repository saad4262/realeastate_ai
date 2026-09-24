import { Suspense } from 'react';
import Link from 'next/link';
import { AppShell } from '@repo/ui';
import { ListingCard } from '../components/listing-card';
import { SearchBar } from '../components/search-bar';
import { SearchBarSkeleton } from '../components/skeletons';
import { PrefetchOnIntent } from '../components/prefetch-on-intent';
import { cachedFilterOptions, cachedSearch } from '../lib/cached';
import styles from './home.module.css';

/** Listings change when an agency publishes, so this is not a static page. */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Both cached, and the filter options are one call rather than two.
  const [{ rows: latest, down }, { propertyTypes }] = await Promise.all([
    cachedSearch({ limit: 6 }),
    cachedFilterOptions(),
  ]);

  return (
    <AppShell surface="web">
      <section className={styles.hero}>
        <h1 className={styles.title}>Find your next home in Sydney</h1>
        <p className={styles.sub}>
          Every listing here comes straight from the agency that holds it.
        </p>
        {/* Sized, not null. SearchBar reads useSearchParams, so it must sit
            behind a boundary; a null fallback reserved no height and the hero
            reflowed when the bar hydrated. */}
        <Suspense fallback={<SearchBarSkeleton />}>
          <SearchBar propertyTypes={propertyTypes} />
        </Suspense>

        {/* The other way in, for a visitor who knows what they want but not
            which filters say it. Deliberately quiet: the filter search is
            still the faster path for anyone who does. */}
        <p className={styles.guideLine}>
          Not sure where to start?{' '}
          <Link href="/chat" className={styles.guideLink} prefetch={false}>
            Ask our property guide
          </Link>
        </p>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Latest listings</h2>
          {latest.length ? <span className={styles.count}>{latest.length} live</span> : null}
        </div>

        {latest.length ? (
          <PrefetchOnIntent className={styles.grid}>
            {latest.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </PrefetchOnIntent>
        ) : (
          <p className={styles.empty}>
            {down
              ? 'Listings are temporarily unavailable. Please try again shortly.'
              : 'No listings are live yet. Agencies publish from their console, and they appear here straight away.'}
          </p>
        )}
      </section>
    </AppShell>
  );
}
