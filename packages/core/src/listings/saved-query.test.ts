import { describe, expect, it } from 'vitest';
import {
  describeSavedQuery,
  parseSearchParams,
  savedQueryToPath,
  type SavedSearchQuery,
} from './search-url';

const parse = (qs: string) => parseSearchParams(new URLSearchParams(qs));

/**
 * A saved search and a `/search?…` link are the same thing written two ways,
 * and the whole scheduler rests on that being true: the browser hands over a
 * link, the server parses it into what gets stored, and the email turns it
 * back into a link. A round trip that loses a filter silently emails somebody
 * the wrong homes.
 */
describe('parseSearchParams', () => {
  it('reads the filters a real search page produces', () => {
    expect(parse('channel=rent&suburb=Pakenham&state=VIC&radius=30&beds=3&priceTo=700')).toEqual({
      channel: 'rent',
      suburb: 'Pakenham',
      state: 'VIC',
      radiusKm: 30,
      bedrooms: 3,
      priceTo: 700,
    });
  });

  it('drops a value that has been hand-edited into nonsense, keeping the rest', () => {
    const q = parse('channel=rent&suburb=Pakenham&beds=banana&type=2jkads&priceTo=-5');

    expect(q.channel).toBe('rent');
    expect(q.suburb).toBe('Pakenham');
    expect(q.bedrooms).toBeUndefined();
    expect(q.propertyType).toBeUndefined();
    expect(q.priceTo).toBeUndefined();
  });

  it('ignores a parameter it has never heard of rather than refusing the link', () => {
    // A link is not a form. An old shared URL with a retired filter should
    // still save the parts that are still real.
    expect(parse('channel=sale&suburb=Bondi&petFriendly=1')).toEqual({
      channel: 'sale',
      suburb: 'Bondi',
    });
  });

  /**
   * The bug this repo has already had twice, in parse form: the text filter
   * is ANDed over everything else, so a suburb's own name travelling as `q`
   * deletes every neighbouring suburb the radius just added.
   */
  it("does not keep a suburb's own name as a keyword", () => {
    expect(parse('suburb=Pakenham&q=Pakenham&radius=30').text).toBeUndefined();
    expect(parse('suburb=Pakenham&q=pool&radius=30').text).toBe('pool');
  });

  it('drops coordinates when there is no radius to use them with', () => {
    const q = parse('suburb=Pakenham&lat=-38.07&lng=145.48');
    expect(q.lat).toBeUndefined();
    expect(q.lng).toBeUndefined();
  });

  it('normalises a lower-case state', () => {
    expect(parse('suburb=Pakenham&state=vic').state).toBe('VIC');
  });
});

describe('savedQueryToPath', () => {
  it('round-trips every filter it can store', () => {
    const original =
      'channel=rent&beds=3&baths=2&cars=1&type=house&priceFrom=400&priceTo=700&sort=newest&suburb=Pakenham&state=VIC&postcode=3810&radius=30';

    const parsed = parse(original);
    const back = parse(savedQueryToPath(parsed).split('?')[1] ?? '');

    expect(back).toEqual(parsed);
  });

  /**
   * The asymmetry `searchQueryToParams` documents, asserted here too: a named
   * suburb is re-resolved by /search from place_cache, so sending coordinates
   * beside it can only disagree with it.
   */
  it('suppresses coordinates when a suburb is named, and keeps them when not', () => {
    const withSuburb: SavedSearchQuery = {
      suburb: 'Pakenham',
      radiusKm: 30,
      lat: -38.07,
      lng: 145.48,
    };
    expect(savedQueryToPath(withSuburb)).not.toContain('lat=');

    const addressOnly: SavedSearchQuery = { radiusKm: 2, lat: -33.89, lng: 151.27 };
    expect(savedQueryToPath(addressOnly)).toContain('lat=-33.89');
  });

  it('is /search with nothing on it when there is nothing to say', () => {
    expect(savedQueryToPath({})).toBe('/search');
  });
});

describe('describeSavedQuery', () => {
  it('reads as a sentence a person would recognise', () => {
    expect(
      describeSavedQuery({ channel: 'rent', suburb: 'Pakenham', radiusKm: 30, bedrooms: 3 }),
    ).toBe('3+ bed homes to rent in Pakenham and within 30 km');

    expect(describeSavedQuery({ channel: 'sale', suburb: 'Bondi', propertyType: 'house' })).toBe(
      'houses for sale in Bondi',
    );
  });

  /**
   * A rental cap is per week and a sale cap is not. "under $700" about a
   * rental reads as a typo, and this string is the one that goes in an email
   * subject line.
   */
  it('says a week for a rental cap and not for a sale one', () => {
    expect(describeSavedQuery({ channel: 'rent', priceTo: 700 })).toContain('under $700 a week');
    expect(describeSavedQuery({ channel: 'sale', priceTo: 900000 })).toContain('under $900,000');
    expect(describeSavedQuery({ channel: 'sale', priceTo: 900000 })).not.toContain('a week');
  });
});
