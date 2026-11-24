import Link from 'next/link';
import { WebShell } from '../components/web-shell';
import { ListingCard } from '../components/listing-card';
import { PrefetchOnIntent } from '../components/prefetch-on-intent';
import { HomeSearch } from '../components/home-search';
import { cachedSearch } from '../lib/cached';
import { portalFonts } from './portal-fonts';
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
 * The search hero (HomeSearch, ADR 0099) reads no session and asks the server
 * nothing until someone types, so the page is still static. Recent searches
 * live in the visitor's browser for the same reason.
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

/** Pages we already have, as a portal's "explore" row. No news: we have none. */
const EXPLORE = [
  {
    href: '/affordability',
    title: 'What can I afford?',
    text: 'Repayments, stamp duty and the cash you need upfront, from rates we check.',
    cta: 'Open the calculator',
    icon: '$',
  },
  {
    href: '/sold',
    title: 'Recently sold',
    text: 'What homes near you actually sold for, and when.',
    cta: 'See sold homes',
    icon: '✓',
  },
  {
    href: '/alerts',
    title: 'Get property alerts',
    text: 'New listings that match your search, emailed when they appear.',
    cta: 'Set up an alert',
    icon: '✉',
  },
] as const;

export default async function HomePage() {
  const { rows: latest, down } = await cachedSearch({ limit: 6 });

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
    <WebShell wide>
      {/*
        The portal skin, as on /search and /listing (the user, 2026-11-10:
        the home page looked like a different product). One attribute
        redefines every token below, so home.module.css and the cards follow
        without a class being renamed. It costs `/` the two portal fonts on
        its critical path; the user chose the look.
      */}
      <div data-skin="portal" data-page="home" className={`${portalFonts} min-h-screen bg-canvas`}>
        <div className="mx-auto w-full max-w-[1100px] px-gutter py-xl">
          <HomeSearch starters={STARTERS} />

          <section className={styles.section} aria-labelledby="explore-title">
            <div className={styles.sectionHead}>
              <h2 id="explore-title" className={styles.sectionTitle}>
                Explore all things property
              </h2>
            </div>
            <div className={styles.explore}>
              {EXPLORE.map((tile) => (
                <Link key={tile.href} href={tile.href} className={styles.tile}>
                  <span className={styles.tileArt} aria-hidden>
                    {tile.icon}
                  </span>
                  <h3 className={styles.tileTitle}>{tile.title}</h3>
                  <p className={styles.tileText}>{tile.text}</p>
                  <span className={styles.tileLink}>{tile.cta}</span>
                </Link>
              ))}
            </div>
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
        </div>
        {/* prefetch off: /chat is force-dynamic, so prefetching it on sight renders the guide for every visitor. */}
        <Link href="/chat" prefetch={false} className={styles.askFloat}>
          <span aria-hidden>✦</span> Ask AI
        </Link>
      </div>
    </WebShell>
  );
}
