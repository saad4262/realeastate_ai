'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState, useTransition, type FormEvent } from 'react';
import { DEFAULT_RADIUS_KM, type ResolvedPlace } from '@repo/core/geo/schema';
import { propertyTypeLabel } from '@repo/core/listings/schema';
/**
 * From the leaf, NOT from ./facets.
 *
 * search-facets.ts runs the query, so it imports `listing` and `property` from
 * @repo/db as values, and @repo/db reaches postgres.js, which imports `net`.
 * This file is a client component: importing priceLadder from there broke
 * every page on the site with "Can't resolve 'net'". The type import below is
 * erased at compile time and is safe.
 */
import { priceLadder } from '@repo/core/listings/price-ladder';
import type { SearchFacets } from '@repo/core/listings';
import { LocationInput } from './location-input';
import styles from './search-bar.module.css';

/**
 * Radii a buyer actually thinks in. Anything wider is a suburb list, not a
 * search. The empty option is the default and is not "no filter" — it is
 * "this suburb and nothing else".
 */
const RADII = [2, 5, 10, 20, 50];

/**
 * Radius stays a fixed ladder, and it is the only one that does.
 *
 * Every other control here now offers what is actually listed — see the
 * `facets` prop below. Distance is not a property of the data: "within 10 km"
 * is a question about the map, and the honest answer to a radius that finds
 * nothing is an empty result with the radius still set, not a missing option.
 * Narrowing this to radii that happen to return something would also cost a
 * PostGIS query per rung on every page load.
 */

/**
 * The consumer search box.
 *
 * Everything lands in the URL rather than component state so a result page can
 * be shared, bookmarked and rendered on the server. That includes the chosen
 * coordinates: a link to "within 5 km of Bondi Beach" has to survive being
 * pasted into a message.
 *
 * It does NOT take the list of live suburbs. That list was rendered into a
 * <datalist id="suburb-options"> that no input ever referenced with a `list`
 * attribute, so every live suburb was serialised into this page's payload, and
 * into the DOM, to do nothing.
 *
 * ## The URL is the only copy of the search
 *
 * This used to mirror eleven search parameters into useState, initialised once
 * from useSearchParams and never re-read. The component is not remounted when
 * the URL changes, so the initialisers never ran again and the two drifted:
 *
 *   1. search "Pakenham, 3 beds"      — box and results agree
 *   2. search "Bondi, 2 beds"         — box and results agree
 *   3. press Back                     — URL and results revert to Pakenham,
 *                                       the box still reads Bondi/2 beds
 *
 * and the next submit sent the stale box. The fix is not to sync the mirror,
 * it is to not keep one: every field below is an uncontrolled input whose
 * defaultValue is read from the URL, and the whole form is keyed on the URL,
 * so Back and Forward re-mount it with the right values by construction. There
 * is nothing left that can disagree.
 *
 * ## It is a real GET form
 *
 * action="/search" method="get" with named inputs produces exactly the URL
 * search/page.tsx already parses, so the search works with no JavaScript at
 * all. onSubmit intercepts to keep the soft navigation and the in-button
 * spinner; the native path is what happens when that never runs.
 */
export function SearchBar({ facets }: { facets: SearchFacets }) {
  const router = useRouter();
  const params = useSearchParams();
  const formRef = useRef<HTMLFormElement>(null);

  /**
   * The navigation runs as a transition, which is what stops the page blanking.
   *
   * Without it Next swaps in search/loading.tsx — the whole page, hero and
   * search box included, replaced by a skeleton and then rebuilt. It reads as a
   * full reload because visually it is one. Inside a transition React keeps the
   * current page on screen until the next one is ready, and `searching` carries
   * the only thing that should change meanwhile: that something is happening.
   */
  const [searching, startSearching] = useTransition();

  const initial = (key: string) => params.get(key) ?? '';

  /**
   * The three things that genuinely cannot be uncontrolled.
   *
   * `channel` decides which set of price options exists at all — sale prices
   * and weekly rents are different orders of magnitude. `place` decides whether
   * the radius control exists and carries the hidden fields. `text` has to be
   * controlled because LocationInput debounces on it.
   *
   * None of them can drift from the URL, because the form they live in is keyed
   * on it and re-mounts when it changes.
   */
  const [channel, setChannel] = useState(initial('channel') || 'sale');
  const [text, setText] = useState(initial('q'));
  /**
   * A display-only echo of the radius select, for the sentence beside it.
   *
   * The select itself stays uncontrolled — this is not a second source of
   * truth, it is what the hint reads. It cannot drift from the URL for the
   * same reason nothing else here can: the form is keyed on it.
   */
  const [radiusEcho, setRadiusEcho] = useState(initial('radius'));
  const [more, setMore] = useState(
    // Opened when the visitor arrived on a link that uses them, so the filters
    // shaping their results are never invisible.
    Boolean(params.get('baths') || params.get('cars') || params.get('type') || params.get('priceFrom')),
  );

  /**
   * The place the visitor picked from the dropdown.
   *
   * suburb/state/postcode are what make the search exact — there is a Richmond
   * in four states — and the coordinates are what the radius is drawn from.
   * Both travel in the URL so the result page can be shared.
   */
  const [place, setPlace] = useState<{
    lat: string;
    lng: string;
    suburb: string | null;
    state: string | null;
    postcode: string | null;
  } | null>(
    params.get('suburb') || (params.get('lat') && params.get('lng'))
      ? {
          lat: initial('lat'),
          lng: initial('lng'),
          suburb: params.get('suburb'),
          state: params.get('state'),
          postcode: params.get('postcode'),
        }
      : null,
  );

  /** Write straight to the DOM node — these inputs have no React state. */
  function setField(name: string, value: string) {
    const el = formRef.current?.elements.namedItem(name);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = value;
  }

  /** The select and the sentence beside it, together. */
  function setRadius(value: string) {
    setField('radius', value);
    setRadiusEcho(value);
  }

  function onPlace(resolved: ResolvedPlace | null) {
    if (!resolved) {
      setPlace(null);
      setRadius('');
      return;
    }
    setPlace({
      lat: resolved.latitude.toFixed(6),
      lng: resolved.longitude.toFixed(6),
      suburb: resolved.suburb,
      state: resolved.state,
      postcode: resolved.postcode,
    });
    // A street address has no suburb of its own to search, so it needs a radius
    // to mean anything. A suburb does: picking Pakenham means Pakenham until
    // the visitor asks for its surrounds too.
    if (resolved.kind === 'address' && !currentRadius()) {
      setRadius(String(DEFAULT_RADIUS_KM.address));
    }
  }

  function currentRadius(): string {
    const el = formRef.current?.elements.namedItem('radius');
    return el instanceof HTMLSelectElement ? el.value : '';
  }

  /** "Pakenham, VIC 3810" — the same shape the dropdown shows. */
  const placeLabel = place
    ? [place.suburb, [place.state, place.postcode].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ')
    : '';

  const isRent = channel === 'rent';

  /**
   * Every option below is read out of what is actually live, per channel.
   *
   * This is the change the whole component was reworked for. The ladders used
   * to be constants: sale prices starting at $750,000 against a database whose
   * dearest listing is $50,000, beds up to 5 where the most any property has
   * is 3, baths up to 4, parking up to 3. Four of six controls could only ever
   * empty the page, which reads as "this portal has nothing" rather than as
   * "that filter was fiction".
   *
   * `facets` recomputes when the channel radio flips because it is derived
   * during render from `channel`, which IS state — the one thing on this form
   * that has to be.
   */
  const live = isRent ? facets.rent : facets.sale;
  const prices = priceLadder(live.priceMin, live.priceMax);

  /**
   * Money the way each channel is quoted.
   *
   * A rent ladder is tens of dollars and a sale ladder is hundreds of
   * thousands, so one format cannot serve both: "$0.00M" was what a $450
   * weekly rent rendered as. Sale figures switch to millions only once they
   * are large enough for it to shorten anything.
   */
  const priceLabel = (n: number) => {
    if (isRent) return `$${n.toLocaleString('en-AU')} pw`;
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    if (n >= 10_000) return `$${Math.round(n / 1000)}k`;
    return `$${n.toLocaleString('en-AU')}`;
  };

  /**
   * Coordinates for a place the URL did not carry any.
   *
   * Only reached for a street address. A named suburb never needs this:
   * search/page.tsx resolves that centre itself and overwrites whatever the URL
   * carried, so asking for it here was a round trip whose answer the next
   * render discarded. See the call site.
   */
  async function coordsFor(p: NonNullable<typeof place>) {
    if (p.lat && p.lng) return { lat: p.lat, lng: p.lng };

    const query = [p.suburb, p.state, p.postcode, 'Australia'].filter(Boolean).join(', ');
    if (!query) return null;

    try {
      const res = await fetch(`/api/places?id=${encodeURIComponent(query)}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { place?: { latitude: number; longitude: number } | null };
      if (!data.place) return null;
      return {
        lat: data.place.latitude.toFixed(6),
        lng: data.place.longitude.toFixed(6),
      };
    } catch {
      return null;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    // The whole thing, not just the push: resolving an address's coordinates is
    // a network call too, and leaving it outside the transition means the
    // button sits idle through the one part of this that can take a moment.
    startSearching(async () => {
      await buildAndGo(data);
    });
  }

  /**
   * The URL, built from the form rather than from a copy of it.
   *
   * FormData is read off the submitted form, so what travels is exactly what
   * the visitor can see. That is the whole point of dropping the mirror.
   */
  async function buildAndGo(data: FormData) {
    const next = new URLSearchParams();
    const str = (key: string) => String(data.get(key) ?? '').trim();
    const set = (key: string, value: string) => {
      if (value) next.set(key, value);
    };

    /**
     * The text box only becomes a keyword search when nothing was picked.
     *
     * Choosing "Pakenham" from the dropdown leaves the word "Pakenham" in the
     * box — it is the label of what was chosen, not something to also match on.
     * Sending it as `q` as well ANDed a free-text filter over the location:
     *   (in Pakenham OR within 50 km) AND ("pakenham" appears somewhere)
     * which quietly deleted every neighbouring suburb the radius had just
     * brought in. Nar Nar Goon North is 5.6 km away and has no "pakenham" in
     * its address, so a 50 km search returned only Pakenham itself and looked
     * for all the world like a broken distance filter.
     */
    if (!place) set('q', str('q'));
    set('channel', str('channel'));
    set('beds', str('beds'));
    set('baths', str('baths'));
    set('cars', str('cars'));
    set('type', str('type'));
    set('priceFrom', str('priceFrom'));
    set('priceTo', str('priceTo'));
    set('sort', str('sort'));

    if (place) {
      // Suburb, state and postcode are the exact match. They go every time,
      // with or without a radius.
      if (place.suburb) next.set('suburb', place.suburb);
      if (place.state) next.set('state', place.state);
      if (place.postcode) next.set('postcode', place.postcode);

      /**
       * Coordinates already in hand travel with the link. Ones that are not are
       * only worth fetching when nothing else can supply the centre.
       *
       * A named suburb is resolved on the server on every search — the page
       * looks the centre up in place_cache and *overwrites* whatever the URL
       * carried, because a browser sending the wrong centre produced a search
       * that was confidently wrong and was reported twice.
       *
       * This is the same rule searchQueryToParams applies in
       * packages/core/src/listings/search-url.ts, which search-url.test.ts
       * covers and the chat's deep links have used all along.
       */
      const coords =
        place.lat && place.lng
          ? { lat: place.lat, lng: place.lng }
          : place.suburb
            ? null
            : await coordsFor(place);

      if (coords?.lat && coords.lng) {
        next.set('lat', coords.lat);
        next.set('lng', coords.lng);
      }

      /**
       * A radius needs a centre, but not necessarily one written in the URL.
       *
       * This used to be nested inside the coordinates check, which is what made
       * choosing a radius on a page rebuilt from a link do nothing at all: no
       * lat/lng meant no radius either, so the dropdown said "+ within 10 km"
       * and the results did not move. A named suburb is a centre the server can
       * find on its own, so the radius travels with it.
       */
      if (place.suburb || (coords?.lat && coords.lng)) {
        set('radius', str('radius'));
      }
    }

    router.push(`/search?${next}`);
  }

  return (
    <form
      /**
       * Re-mount whenever the URL changes.
       *
       * This one line is what makes the defaultValues below trustworthy. Back
       * and Forward change the URL without unmounting this component, so
       * without a key the inputs would keep whatever the visitor last typed
       * while the results behind them said something else.
       */
      key={params.toString()}
      ref={formRef}
      className={styles.bar}
      // The no-JavaScript path. Named inputs under a GET submit produce the
      // same URL search/page.tsx parses, so the search still works.
      action="/search"
      method="get"
      onSubmit={onSubmit}
      role="search"
    >
      <div className={styles.channels}>
        {[
          { id: 'sale', label: 'Buy' },
          { id: 'rent', label: 'Rent' },
        ].map((c) => (
          /* A real radio group, so the channel travels with a native submit.
             The label carries the styling the button used to. */
          <label
            key={c.id}
            className={channel === c.id ? `${styles.channel} ${styles.channelOn}` : styles.channel}
          >
            <input
              type="radio"
              name="channel"
              value={c.id}
              checked={channel === c.id}
              className={styles.srOnly}
              onChange={() => {
                setChannel(c.id);
                // Sale and rent prices are different orders of magnitude, so a
                // bound carried across reads as "no results anywhere". These
                // are uncontrolled, so they are cleared on the node itself.
                setField('priceFrom', '');
                setField('priceTo', '');
              }}
            />
            {c.label}
          </label>
        ))}

        {/*
          A channel with nothing in it says so, here, rather than on the
          results page.

          There is not one rental on this platform, so switching to Rent
          searched, found nothing, and rendered "Nothing matched that search.
          Try a wider price range" — advice that cannot help, about a filter
          the visitor did not set. The count comes from the same facets query
          that fills every dropdown, so it costs nothing to say.
        */}
        {live.total === 0 ? (
          <span className={styles.channelNote}>
            Nothing is listed {isRent ? 'for rent' : 'for sale'} yet.
          </span>
        ) : null}
      </div>

      <div className={styles.row}>
        <LocationInput value={text} onChange={setText} onPlace={onPlace} name="q" />

        <select
          className={styles.select}
          name="beds"
          defaultValue={initial('beds')}
          aria-label="Minimum bedrooms"
        >
          <option value="">Any beds</option>
          {/* Only counts some live property actually has. The filter is "N or
              more", so the largest value present is the largest that can still
              return a result — and nothing above it is offered. */}
          {live.bedrooms.map((n) => (
            <option key={n} value={n}>
              {n}+ beds
            </option>
          ))}
        </select>

        <select
          className={styles.select}
          name="priceTo"
          defaultValue={initial('priceTo')}
          aria-label="Maximum price"
        >
          <option value="">Any price</option>
          {prices.map((n) => (
            <option key={n} value={n}>
              Up to {priceLabel(n)}
            </option>
          ))}
        </select>

        <button type="submit" className={styles.go} disabled={searching}>
          {/* In the button, because that is where the click was and where the
              eye already is. A separate bar elsewhere on the page makes people
              look for what moved. */}
          {searching ? <span className={styles.spin} aria-hidden /> : null}
          {searching ? 'Searching' : 'Search'}
        </button>
      </div>

      {/* The chosen place, for the server. Hidden rather than absent so a
          native submit carries them too. */}
      {place ? (
        <>
          <input type="hidden" name="suburb" value={place.suburb ?? ''} />
          <input type="hidden" name="state" value={place.state ?? ''} />
          <input type="hidden" name="postcode" value={place.postcode ?? ''} />
          <input type="hidden" name="lat" value={place.lat} />
          <input type="hidden" name="lng" value={place.lng} />
        </>
      ) : null}

      {/*
        The area control cannot exist before a place does — a radius with no
        centre is meaningless. But an invisible option is an option nobody finds,
        and this one was reported as missing. One line says it is there and what
        reveals it.
      */}
      {!place ? (
        <p className={styles.areaHint}>
          Pick a suburb from the list to search a distance around it as well.
        </p>
      ) : null}

      <div className={styles.radiusRow} hidden={!place}>
        <label htmlFor="radius" className={styles.radiusLabel}>
          Area
        </label>
        {/* Rendered even with no place, just hidden, so the node exists for
            onPlace to write a default radius into the moment one is picked. */}
        <select
          id="radius"
          name="radius"
          className={styles.select}
          defaultValue={initial('radius')}
          onChange={(e) => setRadiusEcho(e.target.value)}
        >
          {/* The default is the suburb itself. Widening is a deliberate act,
              and the wording says what each choice actually does rather than
              leaving "within 5 km" to imply it replaced the suburb. */}
          <option value="">{placeLabel || 'This location'} only</option>
          {RADII.map((km) => (
            <option key={km} value={km}>
              + within {km} km
            </option>
          ))}
        </select>
        <span className={styles.radiusHint}>
          {radiusEcho
            ? `${placeLabel} plus anything within ${radiusEcho} km of it`
            : `Only listings in ${placeLabel || 'this location'}`}
        </span>
        <button
          type="button"
          className={styles.clearPin}
          onClick={() => {
            setPlace(null);
            setRadius('');
          }}
        >
          Clear location
        </button>
      </div>

      {/* <details> rather than a button, so More filters opens without
          JavaScript. The state only drives the label. */}
      <details
        className={styles.more}
        open={more}
        onToggle={(e) => setMore(e.currentTarget.open)}
      >
        <summary className={styles.moreToggle}>{more ? 'Fewer filters' : 'More filters'}</summary>

        <div className={styles.moreRow}>
          <select
            className={styles.select}
            name="priceFrom"
            defaultValue={initial('priceFrom')}
            aria-label="Minimum price"
          >
            <option value="">No minimum</option>
            {prices.map((n) => (
              <option key={n} value={n}>
                From {priceLabel(n)}
              </option>
            ))}
          </select>

          <select
            className={styles.select}
            name="baths"
            defaultValue={initial('baths')}
            aria-label="Minimum bathrooms"
          >
            <option value="">Any baths</option>
            {live.bathrooms.map((n) => (
              <option key={n} value={n}>
                {n}+ baths
              </option>
            ))}
          </select>

          <select
            className={styles.select}
            name="cars"
            defaultValue={initial('cars')}
            aria-label="Minimum car spaces"
          >
            <option value="">Any parking</option>
            {live.carSpaces.map((n) => (
              <option key={n} value={n}>
                {n}+ car
              </option>
            ))}
          </select>

          <select
            className={styles.select}
            name="type"
            defaultValue={initial('type')}
            aria-label="Property type"
          >
            <option value="">Any type</option>
            {/* Only types with something live in them, so no choice here can
                produce an empty page by itself. This was the one control that
                already had that rule; now they all do. */}
            {live.propertyTypes.map((t) => (
              <option key={t} value={t}>
                {propertyTypeLabel(t)}
              </option>
            ))}
          </select>

          <select
            className={styles.select}
            name="sort"
            defaultValue={initial('sort')}
            aria-label="Sort results"
          >
            <option value="">{place ? 'Nearest first' : 'Newest first'}</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
            <option value="newest">Newest first</option>
          </select>
        </div>
      </details>
    </form>
  );
}
