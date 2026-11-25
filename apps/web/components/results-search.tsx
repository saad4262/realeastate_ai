'use client';

import { useSearchParams } from 'next/navigation';
import { parseLoc, type PlaceRef } from '@repo/core/listings/url';
import { HomeSearch, NO_FILTERS, type Chip, type SearchStart } from './home-search';

const label = (p: PlaceRef) =>
  [p.suburb, [p.state, p.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');

/**
 * The search box above /search and /sold results (ADR 0099): the home page's
 * box, started from this page's URL, so the suburbs, distance and filters
 * that produced these results are on screen and the next search keeps them.
 *
 * The URL is the only copy of the search. Keyed on it, so Back and Forward
 * re-mount the box with the right values rather than leaving a stale one over
 * different results (the rule search-bar.tsx was built around).
 */
export function ResultsSearch({ sold = false }: { sold?: boolean }) {
  const params = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';

  const single = get('suburb')
    ? [{ suburb: get('suburb'), state: get('state') || undefined, postcode: get('postcode') || undefined }]
    : [];
  const chips: Chip[] = [...single, ...params.getAll('loc').map(parseLoc)]
    .filter((p): p is PlaceRef => p !== null)
    .map((p) => ({ ...p, label: label(p) }));

  const lat = Number(get('lat'));
  const lng = Number(get('lng'));
  const point =
    !chips.length && get('lat') && get('lng') && Number.isFinite(lat) && Number.isFinite(lng)
      ? { label: 'The area you picked', lat, lng }
      : null;

  const start: SearchStart = {
    tab: sold ? 'sold' : get('new') === '1' ? 'build' : get('channel') === 'rent' ? 'rent' : 'buy',
    text: chips.length || point ? '' : get('q'),
    chips,
    point,
    radius: get('radius') || get('radiusKm'),
    filters: {
      ...NO_FILTERS,
      types: params.getAll('type'),
      beds: get('beds'),
      baths: get('baths'),
      cars: get('cars'),
      priceFrom: get('priceFrom'),
      priceTo: get('priceTo'),
    },
    sort: get('sort') || undefined,
    keywords: params.getAll('kw'),
  };

  return <HomeSearch key={params.toString()} variant="bar" start={start} />;
}
