'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { DEFAULT_RADIUS_KM, type ResolvedPlace } from '@repo/core/geo/schema';
import { LocationInput } from './location-input';
import { Spinner } from './spinner';
import styles from './search-bar.module.css';

/**
 * Filters this box no longer shows, and must therefore never destroy.
 *
 * Buy/Rent, beds, price, baths, parking, type and the radius used to be
 * controls here. They are the property guide's job now — it writes them into
 * the URL through packages/core/listings/search-url.ts — but the URL is still
 * the only copy of the search, and this form still submits a whole URL. A
 * visitor who refines "3-bed rentals under $600" by typing a suburb into this
 * box would have lost every one of those filters if the form rebuilt the query
 * from what it can see.
 *
 * So they travel: as hidden inputs, so a native GET submit carries them too,
 * and through buildAndGo, which reads them straight back out of the FormData.
 *
 * `radius` is NOT in this list. It is meaningless without a centre, so it is
 * carried inside the place block below and dropped with the place.
 */
const CARRIED = [
  'channel',
  'beds',
  'baths',
  'cars',
  'type',
  'priceFrom',
  'priceTo',
  'sort',
] as const;

/** "Pakenham, VIC 3810" — the shape the suggestion dropdown shows. */
function labelOf(p: { suburb?: string | null; state?: string | null; postcode?: string | null }) {
  return [p.suburb, [p.state, p.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

/**
 * The consumer search box: one field, searched by name.
 *
 * It was a six-control panel — Buy/Rent, beds, a price ceiling, an area
 * radius, and four more under "More filters". All of that is a question the
 * property guide can be asked in a sentence, and every one of those controls
 * was a second place a filter lived. What is left is the one thing a portal
 * cannot ask a model to do on its behalf: name a place and go there.
 *
 * ## What did NOT change
 *
 * The URL vocabulary. search/page.tsx still parses all twelve parameters and
 * the chat still writes them, so a shared link, a saved search and an alert
 * built before this change all still resolve. Only the chrome is gone — see
 * `CARRIED` for what that costs and how it is paid.
 *
 * ## The URL is the only copy of the search
 *
 * This used to mirror eleven search parameters into useState, initialised once
 * from useSearchParams and never re-read. The component is not remounted when
 * the URL changes, so the initialisers never ran again and the two drifted:
 * searching Pakenham, then Bondi, then pressing Back left the box reading
 * Bondi over Pakenham's results, and the next submit sent the stale box.
 *
 * The fix was not to sync the mirror, it was to not keep one. The form is
 * keyed on the URL, so Back and Forward re-mount it with the right values by
 * construction. That rule survives the rewrite and is why `text`, `place` and
 * `radius` can be state at all.
 *
 * ## It is a real GET form
 *
 * action="/search" method="get" with named inputs produces exactly the URL
 * search/page.tsx already parses, so the search works with no JavaScript at
 * all. onSubmit intercepts to keep the soft navigation and the in-button
 * spinner; the native path is what happens when that never runs.
 */
export function SearchBar({
  action = '/search',
}: {
  /**
   * Which results page the box searches. `/sold` takes the same place
   * parameters, so the one box serves both — a second search box would be a
   * second place the location rules could drift.
   */
  action?: '/search' | '/sold';
} = {}) {
  const router = useRouter();
  const params = useSearchParams();

  /**
   * The navigation runs as a transition, which is what stops the page blanking.
   *
   * Without it Next swaps in search/loading.tsx — the whole page, box included,
   * replaced by a skeleton and then rebuilt. It reads as a full reload because
   * visually it is one. Inside a transition React keeps the current page on
   * screen until the next one is ready, and `searching` carries the only thing
   * that should change meanwhile: that something is happening.
   */
  const [searching, startSearching] = useTransition();

  const initial = (key: string) => params.get(key) ?? '';

  /**
   * The place the visitor picked from the dropdown.
   *
   * suburb/state/postcode are what make the search exact — there is a Richmond
   * in four states — and the coordinates are what a radius is drawn from. Both
   * travel in the URL so the result page can be shared.
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

  /**
   * The box shows the place it is searching, rather than sitting empty.
   *
   * The suburb used to be legible from the "Area — Pakenham only" row under
   * the box. That row is gone with the radius control, and an empty field over
   * results headed "for sale in Pakenham" leaves the only mutable part of the
   * search invisible: there is nothing to edit, and no way to tell whether the
   * place is still set. Prefilling the name is what makes this a search *by
   * name* rather than a box that forgets what it was asked.
   *
   * It is a label, not a term — see buildAndGo, which is why it is never also
   * sent as `q`.
   */
  const [text, setText] = useState(
    initial('q') ||
      labelOf({
        suburb: params.get('suburb'),
        state: params.get('state'),
        postcode: params.get('postcode'),
      }),
  );

  /**
   * Carried, not shown.
   *
   * There is no radius control any more — "within 20 km of Pakenham" is a
   * sentence for the guide. But a link that already has one keeps it, and a
   * picked street address still gets one, because an address has no suburb of
   * its own to search and without a radius it matches nothing at all.
   */
  const [radius, setRadius] = useState(initial('radius'));

  function onPlace(resolved: ResolvedPlace | null) {
    if (!resolved) {
      setPlace(null);
      // A radius with no centre is meaningless, and a stale one would redraw
      // the next search's circle around the place just typed away from.
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
    if (resolved.kind === 'address' && !radius) setRadius(String(DEFAULT_RADIUS_KM.address));
  }

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
   * the visitor can see — plus the hidden fields that carry what they cannot.
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

    for (const key of CARRIED) set(key, str(key));

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

      // A radius needs a centre, but not necessarily one written in the URL: a
      // named suburb is a centre the server can find on its own.
      if (place.suburb || (coords?.lat && coords.lng)) set('radius', str('radius'));
    }

    router.push(`${action}?${next}`);
  }

  return (
    <form
      /**
       * Re-mount whenever the URL changes.
       *
       * This one line is what makes the state above trustworthy. Back and
       * Forward change the URL without unmounting this component, so without a
       * key the box would keep whatever the visitor last typed while the
       * results behind it said something else.
       */
      key={params.toString()}
      className={styles.bar}
      // The no-JavaScript path. Named inputs under a GET submit produce the
      // same URL search/page.tsx parses, so the search still works.
      action={action}
      method="get"
      onSubmit={onSubmit}
      role="search"
    >
      <div className={styles.row}>
        <LocationInput value={text} onChange={setText} onPlace={onPlace} name="q" />

        <button type="submit" className={styles.go} disabled={searching} aria-busy={searching}>
          {/* In the button, because that is where the click was and where the
              eye already is. A separate bar elsewhere on the page makes people
              look for what moved. */}
          {searching ? <Spinner /> : null}
          {searching ? 'Searching' : 'Search'}
        </button>
      </div>

      {/* Everything the guide set and this box does not show. Hidden rather
          than absent so a native submit carries them too — see CARRIED. */}
      {CARRIED.map((key) =>
        params.get(key) ? (
          <input key={key} type="hidden" name={key} value={params.get(key) ?? ''} />
        ) : null,
      )}

      {/* The chosen place, for the server. Rendered from state, so typing away
          from a suburb removes them — including the radius, which cannot
          outlive the centre it was drawn around. */}
      {place ? (
        <>
          <input type="hidden" name="suburb" value={place.suburb ?? ''} />
          <input type="hidden" name="state" value={place.state ?? ''} />
          <input type="hidden" name="postcode" value={place.postcode ?? ''} />
          <input type="hidden" name="lat" value={place.lat} />
          <input type="hidden" name="lng" value={place.lng} />
          <input type="hidden" name="radius" value={radius} />
        </>
      ) : null}
    </form>
  );
}
