import { Suspense } from 'react';
import type { Metadata } from 'next';
import type { ListingChannel, PublicSearchQuery, SearchSort } from '@repo/core/listings';
import { nearSchema } from '@repo/core/geo/schema';
import { AppShell } from '@repo/ui';
import { SearchBar } from '../../components/search-bar';
import { SearchBarSkeleton, CardGridSkeleton } from '../../components/skeletons';
import { ResultsList, ResultsSummary } from './results';
import { cachedFilterOptions, cachedPlace } from '../../lib/cached';
import styles from '../home.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Search — Property Platform',
};

/** Query params are user input: anything unrecognised is dropped, not trusted. */
function num(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function channelOf(value: string | undefined): ListingChannel | undefined {
  return value === 'sale' || value === 'rent' ? value : undefined;
}

function sortOf(value: string | undefined): SearchSort | undefined {
  return value === 'price_asc' || value === 'price_desc' || value === 'newest'
    ? value
    : undefined;
}

/**
 * The searched circle, if the URL asks for one.
 *
 * All three parts are required. A radius with no centre is meaningless, and a
 * centre with no radius means the visitor asked for the suburb itself — so an
 * absent radius widens nothing rather than quietly defaulting to 5 km.
 *
 * Parsed through the same zod schema the rest of the system uses, so a
 * hand-edited ?lat=999 is dropped rather than handed to PostGIS.
 */
function nearOf(
  lat: string | undefined,
  lng: string | undefined,
  radius: string | undefined,
) {
  if (!lat || !lng || !radius) return undefined;
  const parsed = nearSchema.safeParse({ lat, lng, radiusKm: radius });
  return parsed.success ? parsed.data : undefined;
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };

  /**
   * Started now, awaited later, and not by this page at all.
   *
   * The filter options depend on nothing above them, but they used to be
   * fetched after the suburb centre had already been resolved — two
   * independent reads run one after the other, with the cold one costing a
   * round trip to the database region. Kicking it off here lets it overlap,
   * and handing the promise to a component inside the existing Suspense
   * boundary means the results never wait on it even when it is cold.
   */
  const filterOptions = cachedFilterOptions();

  const suburb = one('suburb')?.trim() || undefined;
  const state = one('state')?.trim() || undefined;
  const postcode = one('postcode')?.trim() || undefined;
  const radiusParam = one('radius');

  let near = nearOf(one('lat'), one('lng'), radiusParam);

  /**
   * When a suburb is named, the server works out the centre itself.
   *
   * The coordinates in the URL come from the browser, and a browser that sends
   * the wrong ones produces a search that is confidently wrong: a radius drawn
   * around Melbourne while the page says "within 50 km of Pakenham", with
   * nothing on screen to show the centre is not where it claims. It was
   * reported exactly that way, twice, and neither of us could see it.
   *
   * A named suburb has one correct centre and the server can look it up — from
   * place_cache, so it costs nothing for anywhere already searched. The URL's
   * coordinates are only trusted when there is no suburb to check them against,
   * which is the case where the visitor picked a street address.
   */
  if (radiusParam && suburb) {
    const km = Number(radiusParam);
    if (Number.isFinite(km) && km > 0) {
      try {
        const centre = await cachedPlace(
          [suburb, state, postcode, 'Australia'].filter(Boolean).join(', '),
        );
        if (centre) {
          const parsed = nearSchema.safeParse({
            lat: centre.latitude,
            lng: centre.longitude,
            radiusKm: km,
          });
          if (parsed.success) near = parsed.data;
        }
      } catch {
        // Fall back to whatever the URL carried. A geocoder outage should cost
        // the radius, not the search.
      }
    }
  }

  const typed = one('q')?.trim() || undefined;

  /**
   * The keyword, once the place's own name has been discounted.
   *
   * A picked suburb leaves its name in the search box, and that name used to
   * travel as `q` as well. The text filter is ANDed over everything else, so
   *   (in Pakenham OR within 50 km) AND ("pakenham" appears somewhere)
   * deleted every neighbouring suburb the radius had just added — a distance
   * filter that looked broken and was not.
   *
   * The form no longer sends it, but links already shared carry it, so the
   * redundancy is discounted here too. A real keyword next to a suburb —
   * "Pakenham" plus "pool" — still filters, because only the place's own name
   * is treated as a label rather than a term.
   */
  const placeWords = [suburb, state, postcode]
    .filter(Boolean)
    .map((v) => (v as string).trim().toLowerCase());
  const text =
    typed && placeWords.length && placeWords.includes(typed.toLowerCase())
      ? undefined
      : typed;

  const query: PublicSearchQuery = {
    text,
    channel: channelOf(one('channel')),
    bedrooms: num(one('beds')),
    bathrooms: num(one('baths')),
    carSpaces: num(one('cars')),
    propertyType: one('type')?.trim() || undefined,
    priceFrom: num(one('priceFrom')),
    priceTo: num(one('priceTo')),
    sort: sortOf(one('sort')),
    near,
    // Always passed. With no radius it is an exact suburb search; with one it
    // is the suburb PLUS its surrounds — searchPublicListings unions them.
    suburb,
    state,
    postcode,
    limit: 48,
  };

  const place = [suburb, state, postcode].filter(Boolean).join(' ');
  const shared = { query, suburb, place, near };

  /**
   * Changes whenever the SEARCH does, which is what makes the spinner appear.
   *
   * A Suspense boundary keeps showing its old children through an update unless
   * its key changes — good for a filter that refines the same list, wrong here,
   * where the visitor has asked a different question and is owed a sign that it
   * is being answered.
   *
   * Keyed on the query this page actually runs rather than on the raw search
   * string, so a parameter that changes nothing — a utm_source on a shared
   * link, a stray key — no longer throws the results away and re-fetches them
   * to show the same answer.
   */
  const searchKey = JSON.stringify(query);

  return (
    <AppShell surface="web">
      <section className={styles.hero}>
        <h1 className={styles.title}>Search</h1>

        {/* The one line that depends on the answer. It streams in beside a
            search box that never leaves the screen. */}
        <Suspense key={`s-${searchKey}`} fallback={<p className={styles.sub}>Searching…</p>}>
          <ResultsSummary {...shared} />
        </Suspense>

        <Suspense fallback={<SearchBarSkeleton />}>
          <SearchBarSlot options={filterOptions} />
        </Suspense>
      </section>

      <section className={styles.section}>
        {/* A grid of card shapes rather than a spinner: the results are about
            to be a grid of cards, and a centred spinner makes the page jump
            from nothing to full height. */}
        <Suspense key={`r-${searchKey}`} fallback={<CardGridSkeleton count={6} />}>
          <ResultsList {...shared} />
        </Suspense>
      </section>
    </AppShell>
  );
}

/**
 * The search box, once its option lists arrive.
 *
 * Awaiting inside the boundary rather than in the page is what keeps the
 * results independent of it: a cold filter-options read delays the box it
 * belongs to and nothing else.
 */
async function SearchBarSlot({
  options,
}: {
  options: Promise<{ suburbs: string[]; propertyTypes: string[] }>;
}) {
  const { propertyTypes } = await options;
  return <SearchBar propertyTypes={propertyTypes} />;
}
