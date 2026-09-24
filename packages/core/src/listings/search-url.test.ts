import { describe, expect, it } from 'vitest';
import type { PublicSearchQuery } from './search-listings';
import {
  discountPlaceWords,
  searchQueryToParams,
  searchQueryToPath,
  SEARCH_PARAM_KEYS,
} from './search-url';

const PAKENHAM = { lat: -38.0709, lng: 145.4844 };

describe('searchQueryToParams', () => {
  it('emits the suburb and the radius, and not the coordinates', () => {
    // The bug this guards was reported twice: /search re-resolves a named
    // suburb's centre server-side, so shipping the browser's coordinates as
    // well is how a radius ends up drawn around the wrong place.
    const query: PublicSearchQuery = {
      channel: 'sale',
      suburb: 'Pakenham',
      state: 'VIC',
      postcode: '3810',
      near: { ...PAKENHAM, radiusKm: 30 },
    };

    const params = searchQueryToParams(query);

    expect(params.get('suburb')).toBe('Pakenham');
    expect(params.get('state')).toBe('VIC');
    expect(params.get('postcode')).toBe('3810');
    expect(params.get('radius')).toBe('30');
    expect(params.get('lat')).toBeNull();
    expect(params.get('lng')).toBeNull();
  });

  it('emits coordinates when there is no suburb to look up', () => {
    // A street address has no name /search can re-resolve, so the point it was
    // given is the only centre there is.
    const params = searchQueryToParams({ near: { ...PAKENHAM, radiusKm: 2 } });

    expect(params.get('lat')).toBe(String(PAKENHAM.lat));
    expect(params.get('lng')).toBe(String(PAKENHAM.lng));
    expect(params.get('radius')).toBe('2');
    expect(params.get('suburb')).toBeNull();
  });

  it('omits everything the query did not set', () => {
    const params = searchQueryToParams({ channel: 'rent', suburb: 'Bondi Beach' });
    expect([...params.keys()].sort()).toEqual(['channel', 'suburb']);
  });

  it('never emits a key /search does not parse', () => {
    const query: PublicSearchQuery = {
      text: 'pool',
      channel: 'sale',
      suburb: 'Pakenham',
      state: 'VIC',
      postcode: '3810',
      bedrooms: 3,
      bathrooms: 2,
      carSpaces: 2,
      propertyType: 'House',
      priceFrom: 500_000,
      priceTo: 800_000,
      landFrom: 400,
      sort: 'price_asc',
      near: { ...PAKENHAM, radiusKm: 10 },
      limit: 24,
    };

    for (const key of searchQueryToParams(query).keys()) {
      expect(SEARCH_PARAM_KEYS).toContain(key);
    }
  });

  it('does not carry limit or landFrom, which /search has no param for', () => {
    // Stated rather than assumed: dropping these silently is correct, but the
    // day /search grows a land filter this test is the reminder.
    const params = searchQueryToParams({ landFrom: 400, limit: 24 });
    expect([...params.keys()]).toEqual([]);
  });

  it('builds a path a browser can follow', () => {
    expect(searchQueryToPath({ channel: 'sale', suburb: 'Pakenham' })).toBe(
      '/search?channel=sale&suburb=Pakenham',
    );
    expect(searchQueryToPath({})).toBe('/search');
  });
});

describe('discountPlaceWords', () => {
  it('drops the suburb name so the radius is not ANDed away', () => {
    expect(discountPlaceWords('Pakenham', { suburb: 'Pakenham' })).toBeUndefined();
    expect(discountPlaceWords('  pakenham ', { suburb: 'Pakenham' })).toBeUndefined();
    expect(discountPlaceWords('VIC', { suburb: 'Pakenham', state: 'VIC' })).toBeUndefined();
    expect(discountPlaceWords('3810', { postcode: '3810' })).toBeUndefined();
  });

  it('keeps a real keyword standing next to a suburb', () => {
    expect(discountPlaceWords('pool', { suburb: 'Pakenham' })).toBe('pool');
  });

  it('keeps a keyword when no place was named', () => {
    expect(discountPlaceWords('Pakenham', {})).toBe('Pakenham');
  });

  it('treats blank text as absent', () => {
    expect(discountPlaceWords('   ', { suburb: 'Pakenham' })).toBeUndefined();
    expect(discountPlaceWords(undefined, { suburb: 'Pakenham' })).toBeUndefined();
  });
});
