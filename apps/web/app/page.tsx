import Link from 'next/link';
import { WebShell } from '../components/web-shell';
import { ListingCard } from '../components/listing-card';
import { PrefetchOnIntent } from '../components/prefetch-on-intent';
import { cachedFilterOptions, cachedSearch } from '../lib/cached';
import { HomeAsk } from './home-ask';
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
 *
 * The filter bar that used to sit in the hero is gone and this is still
 * static, because what replaced it — HomeAsk — reads no session either. See
 * the note in that file.
 */
export const revalidate = 300;

/**
 * Openers, on the home page rather than only inside the chat.
 *
 * Deliberately three sentences and not three filter presets. The point of
 * the box above them is that a person does not have to know the vocabulary
 * of the search to use it, and "Under $900k · 3 beds · Pakenham" would teach
 * them the vocabulary anyway.
 *
 * These are the same three the chat hero offers, written out again rather
 * than imported: `chat-view.tsx` is a client module in another route group,
 * and reaching into it from here would pull the whole guide — the stream
 * reader, the results panel, the map — into this page's graph to read an
 * array of strings.
 */
const STARTERS = [
  'Berwick is home — where should I look next?',
  'Buying around Pakenham, within about 30 km',
  '2-bed rental under $650 a week near Bondi',
] as const;

export default async function HomePage() {
  /*
    Both cached, and both already warm: cachedFilterOptions is derived from
    the same cachedFacets call /search and /chat make, so asking for one
    suburb here costs a map over a cached array rather than a query.
  */
  const [{ rows: latest, down }, { suburbs }] = await Promise.all([
    cachedSearch({ limit: 6 }),
    cachedFilterOptions(),
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

      Which is also why the History link below goes to /chat?history=1 and
      not to a list rendered here: the list is per-person, and asking who is
      looking is the one thing this page cannot do.
    */
    <WebShell>
      <section className={styles.hero}>
        <p className={styles.kicker}>AI-powered property search</p>
        <h1 className={styles.title}>
          Tell us what you need.
          <span className={styles.titleMuted}> We&apos;ll search what&apos;s live.</span>
        </h1>
        <p className={styles.sub}>
          Describe the home you are after the way you would to a local agent — suburb,
          budget, bedrooms, or just the part of town you like. Every price and count comes
          from live agency listings.
        </p>

        <HomeAsk exampleSuburb={suburbs[0] ?? null} starters={STARTERS} />

        {/*
          The second door the visitor asked for: History reachable from the
          home page, not only from inside the guide. It is a link to the
          screen rather than the list itself, for the cookie reason above.

          `prefetch={false}`: /chat is force-dynamic, so prefetching it on
          sight would server-render the guide for every visitor who scrolls
          past this line. HomeAsk warms it on intent instead.
        */}
        <p className={styles.resume}>
          Been here before?{' '}
          <Link href="/chat?history=1" className={styles.resumeLink} prefetch={false}>
            Open your past conversations
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
