import { Suspense } from 'react';
import Link from 'next/link';
import { WebShell } from '../components/web-shell';
import { ListingCard } from '../components/listing-card';
import { SearchBar } from '../components/search-bar';
import { SearchBarSkeleton } from '../components/skeletons';
import { PrefetchOnIntent } from '../components/prefetch-on-intent';
import { cachedFacets, cachedSearch } from '../lib/cached';
import styles from './home.module.css';

/**
 * Cached as a route, not rendered per request.
 *
 * Nothing on this page varies by visitor: no cookie, no header, no search
 * param. It was force-dynamic anyway, so every visit re-rendered six cards
 * from data that was already cached — a server render to read a cache.
 *
 * The invalidation this needs already exists and is already being called. An
 * agent publishing hits revalidateTag('listings') through /api/revalidate
 * within a second, which clears the data this render depends on and the cached
 * render with it. So this is not "add ISR" so much as stop preventing the tag
 * infrastructure from paying off at the route level as well as the data level.
 *
 * `revalidate` is the backstop for when that call never arrives, exactly as it
 * is in lib/cached.ts — never the mechanism. It also bounds the one case a tag
 * cannot reach: a site where nothing has been published yet, whose first build
 * happened to run without a database and baked the "unavailable" state.
 */
export const revalidate = 300;

export default async function HomePage() {
  // Both cached, and every filter option is one call and one query rather
  // than six — see cachedFacets.
  const [{ rows: latest, down }, facets] = await Promise.all([
    cachedSearch({ limit: 6 }),
    cachedFacets(),
  ]);

  return (
    /*
      No `account` prop, and that is the one deliberate hole in the account
      control.

      This is the site's only statically rendered route (`revalidate = 300`,
      measured at 33 ms). Working out whether somebody is signed in means
      reading a cookie, and a `cookies()` call anywhere in this tree opts the
      whole route out of static rendering — so the chip would cost this page
      its cache to draw a link that is one click away on every other page.

      The header therefore reads exactly as it did before: Search · My
      alerts · Ask the guide, where "My alerts" works for both states because
      middleware routes a signed-out visitor through /login and back.
    */
    <WebShell>
      <section className={styles.hero}>
        <p className={styles.kicker}>AI-powered property search</p>
        <h1 className={styles.title}>Find your next home — talk or filter</h1>
        <p className={styles.sub}>
          Search live agency listings across Australia, or ask the guide in plain English.
          Prices and match counts always come from the database, never from the model.
        </p>
        {/* Sized, not null. SearchBar reads useSearchParams, so it must sit
            behind a boundary; a null fallback reserved no height and the hero
            reflowed when the bar hydrated. */}
        <Suspense fallback={<SearchBarSkeleton />}>
          <SearchBar facets={facets} />
        </Suspense>

        {/* The other way in, for a visitor who knows what they want but not
            which filters say it. Deliberately quiet: the filter search is
            still the faster path for anyone who does. */}
        <p className={styles.guideLine}>
          Prefer a conversation?{' '}
          <Link href="/chat" className={styles.guideLink} prefetch={false}>
            Ask the AI property guide
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
    </WebShell>
  );
}
