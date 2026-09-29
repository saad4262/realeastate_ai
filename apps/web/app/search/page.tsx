import { Suspense } from 'react';
import type { Metadata } from 'next';
import type { ListingChannel, PublicSearchQuery, SearchSort } from '@repo/core/listings';
import { nearSchema } from '@repo/core/geo/schema';
import { WebShell } from '../../components/web-shell';
import { SearchBar } from '../../components/search-bar';
import { SearchBarSkeleton, ResultListSkeleton, PanelSkeleton } from '../../components/skeletons';
import { ResultsList, ResultsSummary } from './results';
import { Refreshing, SortBar, SortingProvider } from './sorting';
import { NearbySuburbsPanel, NotConnectedPanel, TopAgentsPanel } from './sidebar';
import { parseSearchParams, savedQueryToPath } from '@repo/core/listings/url';
import { SaveSearch } from '../../components/save-search';
import { looksSignedIn } from '../../lib/session';
import { cachedPlace } from '../../lib/cached';
import { portalFonts } from '../portal-fonts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Search — Property Platform',
};

/**
 * Results per page.
 *
 * Was a hard limit of 48 with nothing after it — result 49 of a search was
 * unreachable, on a portal whose whole job is showing what is for sale. 24 is
 * a page people scroll rather than abandon, and the count beside it says how
 * many there are in total.
 */
const PAGE_SIZE = 24;

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
  return value === 'price_asc' || value === 'price_desc' || value === 'newest' ? value : undefined;
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
function nearOf(lat: string | undefined, lng: string | undefined, radius: string | undefined) {
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

  /*
   * There is no cachedFacets() call here any more.
   *
   * It existed to fill the beds, price, baths, parking and type dropdowns, and
   * every one of those controls has moved into the property guide. The read is
   * still made by / and /chat; this page simply no longer needs it, which is
   * one fewer database round trip on the most-visited URL on the site.
   *
   * The smoke check "no filter option the search box offers can return zero
   * results" still runs against searchFacets directly. It is now guarding the
   * options the GUIDE offers rather than the ones a dropdown did, which is the
   * same rule about the same data.
   */

  /**
   * The same URL, read back as a saved search.
   *
   * Parsed rather than rebuilt from the local variables below, so the thing
   * offered for saving is provably the thing in the address bar — one
   * vocabulary, both directions. `looksSignedIn` is a cookie sniff and
   * decides nothing; the Server Action reads the real session.
   */
  const savedQuery = parseSearchParams(
    new URLSearchParams(
      Object.entries(params).flatMap(([key, value]) =>
        value === undefined
          ? []
          : [[key, Array.isArray(value) ? (value[0] ?? '') : value] as [string, string]],
      ),
    ),
  );
  const signedIn = await looksSignedIn();

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

  /**
   * Which page, 1-based.
   *
   * Anything that is not a whole number above zero is page one — a hand-edited
   * ?page=-3 should show the first page, not an error.
   */
  const pageParam = Number(one('page'));
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

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
    typed && placeWords.length && placeWords.includes(typed.toLowerCase()) ? undefined : typed;

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
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };

  const place = [suburb, state, postcode].filter(Boolean).join(' ');

  /** A link to another page of this same search, keeping every other filter. */
  const pageHref = (n: number) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      const val = Array.isArray(v) ? v[0] : v;
      if (val && k !== 'page') next.set(k, val);
    }
    if (n > 1) next.set('page', String(n));
    const qs = next.toString();
    return qs ? `/search?${qs}` : '/search';
  };

  /** The same link, with one parameter replaced and the page reset to one. */
  const withParam = (key: string, value: string) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      const val = Array.isArray(v) ? v[0] : v;
      // `page` is dropped: changing the sort of a 20-page search and landing
      // on page 7 of the new order is a different search with the old
      // scroll position, which reads as results that will not settle.
      if (val && k !== 'page' && k !== key) next.set(k, val);
    }
    if (value) next.set(key, value);
    const qs = next.toString();
    return qs ? `/search?${qs}` : '/search';
  };

  /**
   * The heading a portal puts above its results.
   *
   * Built from the search rather than fixed, because it is the page's <h1> and
   * the thing a search engine indexes this URL by — "Real estate & property for
   * sale in Pakenham, VIC 3810" is the query, written out. The old <h1> was
   * `sr-only` and said "Search properties" on every search there has ever been.
   */
  const kindLabel = query.channel === 'rent' ? 'for rent' : 'for sale';
  /**
   * Punctuated as an address, not as `place`.
   *
   * `place` is a space-joined "Pakenham VIC 3810" and it is load-bearing in
   * the summary sentence below, so it is left alone. A heading is prose and
   * wants the comma an address is written with.
   */
  const headingPlace = suburb
    ? [suburb, [state, postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    : place;
  const whereLabel = near ? 'in the area you searched' : 'across Australia';
  const heading = `Real estate & property ${kindLabel} ${
    headingPlace ? `in ${headingPlace}` : whereLabel
  }`;

  /**
   * Sort as links, not as a select.
   *
   * It is the last filter with a control on this page, and it keeps one for
   * the reason the others lost theirs: it is a single tap, it is instantly
   * reversible, and it is pure SQL — asking the guide to re-order a list costs
   * a model round trip to produce an ORDER BY.
   *
   * Links, because the href IS the search: middle-click opens the other order
   * in a tab, and with no JavaScript the plain navigation still works. SortBar
   * intercepts the ordinary click to run it as a transition — see sorting.tsx.
   */
  const currentSort = sortOf(one('sort')) ?? '';
  const sorts = [
    { value: '', label: near ? 'Nearest' : 'Featured' },
    { value: 'newest', label: 'Newest' },
    { value: 'price_asc', label: 'Price ↑' },
    { value: 'price_desc', label: 'Price ↓' },
  ].map((s) => ({ ...s, href: withParam('sort', s.value) }));

  const shared = { query, suburb, place, near, page, pageSize: PAGE_SIZE, pageHref };

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
   *
   * `sort` is left out on purpose, and it is the one exception the paragraph
   * above describes rather than a hole in it. Re-ordering is not a different
   * question: the same listings come back in another order, so throwing them
   * away for a skeleton and rebuilding is the flicker that made a sort read as
   * a page reload. With the key unchanged the old rows stay on screen for the
   * whole transition and `Refreshing` shims over them instead.
   *
   * JSON.stringify drops undefined properties, so this is the query minus one
   * key rather than the query with a null in it.
   */
  const searchKey = JSON.stringify({ ...query, sort: undefined });

  return (
    // Outside the middleware matcher, so this is `looksSignedIn()` — a cookie
    // sniff, good enough to choose which of two links to draw and never
    // trusted for anything else. Both destinations re-check on the server.
    <WebShell wide account={{ signedIn }}>
      {/*
        The portal skin.

        One attribute. Every token inside this element is redefined by the
        [data-skin='portal'] block in tailwind.css — white cards on grey,
        crimson as the brand, no serif — so the utilities and the CSS Modules
        below both change together without a single class being renamed.

        It is here rather than on <body> because the header above it is
        AppShell's and shared with / and /chat, which keep the warm green.
      */}
      <SortingProvider>
        <div
          data-skin="portal"
          /* Marks THIS element as the page's own wrapper.

           loading.tsx carries the skin too — it has to, or the page changes
           colour when it arrives — and its shell is streamed into the same
           HTML document. So "is data-skin anywhere in the response" is a
           question the skeleton alone can answer yes to, and it did: removing
           the attribute from this element left the smoke check passing.

           The check now looks for both attributes on one tag, which only this
           element has. */
          data-page="search-results"
          className={`${portalFonts} min-h-screen bg-canvas`}
        >
          <div className="mx-auto w-full max-w-[1200px] px-gutter pb-xl">
            {/*
            The search box first, the heading and count under it — a portal's
            order, and the reverse of what this page did. The box is what a
            visitor came to use; the sentence is the answer to it.

            NOT sticky. AppShell's header already is (top: 0, z-index: 20), and
            a second sticky bar under it has to know that header's height to sit
            below it — a number that lives in another package and changes with
            its padding. One sticky element, and it is the one with the nav in
            it.
          */}
            <div className="py-md">
              {/* Still inside a boundary: SearchBar reads useSearchParams, which
                requires one. It no longer waits on a database read to fill its
                options, because it no longer has any. */}
              <Suspense fallback={<SearchBarSkeleton />}>
                <SearchBar />
              </Suspense>
            </div>

            <h1 className="pt-sm text-headline-xl font-display text-ink">{heading}</h1>

            <div className="mt-sm flex flex-wrap items-center justify-between gap-sm border-b border-line-subtle pb-md">
              {/*
              The one line that depends on the answer, streaming in beside a
              search box that never leaves the screen.

              Its wording is load-bearing beyond this page: packages/smoke reads
              the result count straight out of this rendered HTML with
              /([0-9]+) results?\s+—/, and five checks depend on it. The layout
              around it changed twice now; the sentence deliberately did not.
            */}
              <Suspense
                key={`s-${searchKey}`}
                fallback={<p className="text-body-md text-ink-soft">Searching…</p>}
              >
                <ResultsSummary {...shared} />
              </Suspense>

              <SortBar options={sorts} current={currentSort} />
            </div>

            {/*
            Save this search.

            It is handed the path rather than the parsed filters: the server
            re-parses it with the same vocabulary this page just used, so what
            gets saved is exactly what produced the results above (§ 9). The
            signed-in flag is a display hint only — see looksSignedIn().
          */}
            <div className="pt-md">
              <SaveSearch
                searchPath={savedQueryToPath(savedQuery)}
                signedIn={signedIn}
                hasFilters={Object.keys(savedQuery).length > 0}
              />
            </div>

            {/*
            Results beside a sidebar, 8 and 4 of twelve — the split the listing
            page already uses, so the two public pages have one column system
            between them rather than one each.

            `items-start` is what lets the sidebar stick: a stretched grid item
            is as tall as the results column, and a sticky element inside
            something that tall never has anywhere to stick to.
          */}
            <div className="grid items-start gap-lg pt-lg lg:grid-cols-12">
              <section className="lg:col-span-8">
                {/*
                Two loading states, for two different events, and they never
                both run.

                The skeleton is for a NEW search — the key changed, there is
                nothing on screen worth keeping, and a stack of card shapes
                stops the page jumping from nothing to full height.

                `Refreshing` is for a re-order — the key did not change, the
                rows are still right, and they are dimmed in place until the
                new order arrives.
              */}
                <Refreshing>
                  <Suspense key={`r-${searchKey}`} fallback={<ResultListSkeleton count={4} />}>
                    <ResultsList {...shared} />
                  </Suspense>
                </Refreshing>
              </section>

              {/*
              Its own boundary, and deliberately outside the results one.

              These are two more reads. Inside the results boundary they would
              hold the listings back; awaited in the page they would hold the
              whole page back. In a boundary of their own the results render
              the moment the search returns and the panels arrive when they
              arrive — which is the right priority, because nobody came here
              for the sidebar.
            */}
              <aside className="grid gap-md lg:sticky lg:top-lg lg:col-span-4">
                <Suspense key={`a-${searchKey}`} fallback={<PanelSkeleton rows={3} />}>
                  {suburb ? (
                    <TopAgentsPanel suburb={suburb} state={state} channel={query.channel} />
                  ) : null}
                </Suspense>

                <Suspense key={`n-${searchKey}`} fallback={<PanelSkeleton rows={4} />}>
                  <NearbySuburbsPanel
                    suburb={suburb}
                    state={state}
                    channel={query.channel}
                    near={near}
                  />
                </Suspense>

                <NotConnectedPanel />
              </aside>
            </div>
          </div>
        </div>
      </SortingProvider>
    </WebShell>
  );
}
