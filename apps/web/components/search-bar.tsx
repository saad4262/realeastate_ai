'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { DEFAULT_RADIUS_KM, type ResolvedPlace } from '@repo/core/geo/schema';
import { LocationInput } from './location-input';
import styles from './search-bar.module.css';

/**
 * Radii a buyer actually thinks in. Anything wider is a suburb list, not a
 * search. The empty option is the default and is not "no filter" — it is
 * "this suburb and nothing else".
 */
const RADII = [2, 5, 10, 20, 50];

const SALE_PRICES = [750_000, 1_000_000, 1_500_000, 2_000_000, 3_000_000, 5_000_000];
const RENT_PRICES = [400, 500, 650, 750, 1000, 1500, 2000];

/**
 * The consumer search box.
 *
 * Everything lands in the URL rather than component state so a result page can
 * be shared, bookmarked and rendered on the server. That includes the chosen
 * coordinates: a link to "within 5 km of Bondi Beach" has to survive being
 * pasted into a message.
 *
 * It does NOT take the list of live suburbs any more. That list was rendered
 * into a <datalist id="suburb-options"> that no input ever referenced with a
 * `list` attribute — so every live suburb was serialised into this page's
 * payload, and into the DOM, to do nothing. LocationInput is the real
 * typeahead, and the path for a browser without JavaScript is a plain text
 * box the server still matches by suburb name.
 */
export function SearchBar({ propertyTypes = [] }: { propertyTypes?: string[] }) {
  const router = useRouter();
  const params = useSearchParams();
  /**
   * The navigation runs as a transition, which is what stops the page blanking.
   *
   * Without it Next swaps in app/loading.tsx — the whole page, hero and search
   * box included, replaced by the word "Loading…" and then rebuilt. It reads as
   * a full reload because visually it is one. Inside a transition React keeps
   * the current page on screen until the next one is ready, and `searching`
   * carries the only thing that should change in the meantime: the fact that
   * something is happening.
   */
  const [searching, startSearching] = useTransition();

  const [text, setText] = useState(params.get('q') ?? '');
  const [channel, setChannel] = useState(params.get('channel') ?? 'sale');
  const [beds, setBeds] = useState(params.get('beds') ?? '');
  const [baths, setBaths] = useState(params.get('baths') ?? '');
  const [cars, setCars] = useState(params.get('cars') ?? '');
  const [type, setType] = useState(params.get('type') ?? '');
  const [priceTo, setPriceTo] = useState(params.get('priceTo') ?? '');
  const [priceFrom, setPriceFrom] = useState(params.get('priceFrom') ?? '');
  const [sort, setSort] = useState(params.get('sort') ?? '');
  const [radius, setRadius] = useState(params.get('radius') ?? '');
  const [more, setMore] = useState(
    // Opened by default when the visitor arrived on a link that uses them, so
    // the filters shaping their results are never invisible.
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
          lat: params.get('lat') ?? '',
          lng: params.get('lng') ?? '',
          suburb: params.get('suburb'),
          state: params.get('state'),
          postcode: params.get('postcode'),
        }
      : null,
  );

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
    if (resolved.kind === 'address' && !radius) {
      setRadius(String(DEFAULT_RADIUS_KM.address));
    }
  }

  /** "Pakenham, VIC 3810" — the same shape the dropdown shows. */
  const placeLabel = place
    ? [place.suburb, [place.state, place.postcode].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ')
    : '';

  const isRent = channel === 'rent';
  const prices = isRent ? RENT_PRICES : SALE_PRICES;
  const priceLabel = (n: number) =>
    isRent ? `$${n} pw` : `$${(n / 1_000_000).toFixed(n >= 1_000_000 ? 1 : 2)}M`;

  /**
   * Coordinates for a place the URL did not carry any.
   *
   * Only reached for a street address now. A named suburb never needs this:
   * search/page.tsx resolves that centre itself and overwrites whatever the
   * URL carried, so asking for it here was a round trip whose answer the next
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

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    // The whole thing, not just the push: resolving a suburb's coordinates is a
    // network call too, and leaving it outside the transition means the button
    // sits idle through the one part of this that can actually take a moment.
    startSearching(async () => {
      await buildAndGo();
    });
  }

  async function buildAndGo() {
    const next = new URLSearchParams();
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
    if (!place) set('q', text.trim());
    set('channel', channel);
    set('beds', beds);
    set('baths', baths);
    set('cars', cars);
    set('type', type);
    set('priceFrom', priceFrom);
    set('priceTo', priceTo);
    set('sort', sort);

    if (place) {
      // Suburb, state and postcode are the exact match. They go every time,
      // with or without a radius.
      if (place.suburb) next.set('suburb', place.suburb);
      if (place.state) next.set('state', place.state);
      if (place.postcode) next.set('postcode', place.postcode);

      /**
       * Coordinates already in hand travel with the link. Ones that are not
       * are only worth fetching when nothing else can supply the centre.
       *
       * A named suburb is resolved on the server on every search — the page
       * looks the centre up in place_cache and *overwrites* whatever the URL
       * carried, because a browser sending the wrong centre produced a search
       * that was confidently wrong and was reported twice. So fetching them
       * here was a client → server → database round trip sitting in the
       * critical path of the submit, for a value the next render throws away.
       *
       * A street address has no suburb for the server to resolve against, so
       * there the URL's coordinates are the only centre there is.
       *
       * This is the same rule searchQueryToParams already applies in
       * packages/core/src/listings/search-url.ts — "emit the suburb and the
       * radius, and NOT the coordinates" — which the chat's deep links have
       * used all along and which search-url.test.ts covers. This file was the
       * writer that was out of step. SEARCH_PARAM_KEYS names the drift; the
       * two builders collapse into one when this form becomes a GET form.
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
       * find on its own, so the radius travels with it. With neither a suburb
       * nor coordinates there is nothing to draw a circle around, and a bare
       * ?radius= that widens nothing is still never written.
       */
      if (place.suburb || (coords?.lat && coords.lng)) {
        set('radius', radius);
      }
    }

    router.push(`/search?${next}`);
  }

  return (
    <form className={styles.bar} onSubmit={onSubmit} role="search">
      <div className={styles.channels}>
        {[
          { id: 'sale', label: 'Buy' },
          { id: 'rent', label: 'Rent' },
        ].map((c) => (
          <button
            key={c.id}
            type="button"
            className={channel === c.id ? `${styles.channel} ${styles.channelOn}` : styles.channel}
            aria-pressed={channel === c.id}
            onClick={() => {
              setChannel(c.id);
              // Sale and rent prices are different orders of magnitude, so a
              // bound carried across reads as "no results anywhere".
              setPriceFrom('');
              setPriceTo('');
            }}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className={styles.row}>
        <LocationInput value={text} onChange={setText} onPlace={onPlace} />

        <select
          className={styles.select}
          value={beds}
          onChange={(e) => setBeds(e.target.value)}
          aria-label="Minimum bedrooms"
        >
          <option value="">Any beds</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n}+ beds
            </option>
          ))}
        </select>

        <select
          className={styles.select}
          value={priceTo}
          onChange={(e) => setPriceTo(e.target.value)}
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

      {place ? (
        <div className={styles.radiusRow}>
          <label htmlFor="radius" className={styles.radiusLabel}>
            Area
          </label>
          <select
            id="radius"
            className={styles.select}
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
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
            {radius
              ? `${placeLabel} plus anything within ${radius} km of it`
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
      ) : null}

      <button
        type="button"
        className={styles.moreToggle}
        aria-expanded={more}
        onClick={() => setMore((v) => !v)}
      >
        {more ? 'Fewer filters' : 'More filters'}
      </button>

      {more ? (
        <div className={styles.moreRow}>
          <select
            className={styles.select}
            value={priceFrom}
            onChange={(e) => setPriceFrom(e.target.value)}
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
            value={baths}
            onChange={(e) => setBaths(e.target.value)}
            aria-label="Minimum bathrooms"
          >
            <option value="">Any baths</option>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}+ baths
              </option>
            ))}
          </select>

          <select
            className={styles.select}
            value={cars}
            onChange={(e) => setCars(e.target.value)}
            aria-label="Minimum car spaces"
          >
            <option value="">Any parking</option>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}+ car
              </option>
            ))}
          </select>

          <select
            className={styles.select}
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="Property type"
          >
            <option value="">Any type</option>
            {/* Only types with something live in them, so no choice here can
                produce an empty page by itself. */}
            {propertyTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <select
            className={styles.select}
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            aria-label="Sort results"
          >
            <option value="">{place ? 'Nearest first' : 'Newest first'}</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
            <option value="newest">Newest first</option>
          </select>
        </div>
      ) : null}

    </form>
  );
}
