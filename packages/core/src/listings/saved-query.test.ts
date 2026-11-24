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

/** ADR 0099: `loc` repeats, one per suburb picked in the box. */
describe('several places in the URL', () => {
  it('reads every loc as a place', () => {
    expect(parse('channel=sale&loc=Pakenham|VIC|3810&loc=Berwick|VIC|3806&radius=10')).toEqual({
      channel: 'sale',
      places: [
        { suburb: 'Pakenham', state: 'VIC', postcode: '3810' },
        { suburb: 'Berwick', state: 'VIC', postcode: '3806' },
      ],
      radiusKm: 10,
    });
  });

  it('turns ONE loc into the plain suburb every other reader understands', () => {
    expect(parse('loc=Pakenham|vic|3810')).toEqual({
      suburb: 'Pakenham',
      state: 'VIC',
      postcode: '3810',
    });
  });

  it('drops a repeat, a nonsense value, and the suburb already named', () => {
    const q = parse(
      'suburb=Pakenham&state=VIC&postcode=3810&loc=Pakenham|VIC|3810&loc=Berwick|VIC&loc=Berwick|VIC&loc=|XX|abc&loc=Officer|ZZ',
    );
    expect(q.suburb).toBe('Pakenham');
    expect(q.places).toEqual([{ suburb: 'Berwick', state: 'VIC' }]);
  });

  it('keeps at most ten places in all', () => {
    const qs = Array.from({ length: 14 }, (_, i) => `loc=Place${i}|VIC`).join('&');
    expect(parse(qs).places).toHaveLength(10);
    expect(parse(`suburb=Pakenham&${qs}`).places).toHaveLength(9);
  });

  it('reads several types as propertyTypes and one as propertyType', () => {
    expect(parse('type=house&type=townhouse&type=nonsense')).toEqual({
      propertyTypes: ['house', 'townhouse'],
    });
    expect(parse('type=house')).toEqual({ propertyType: 'house' });
  });

  it('does not keep any picked place name as a keyword', () => {
    expect(parse('loc=Pakenham|VIC&loc=Berwick|VIC&q=berwick').text).toBeUndefined();
    expect(parse('loc=Pakenham|VIC&loc=Berwick|VIC&q=pool').text).toBe('pool');
  });

  it('survives the round trip to a link and back', () => {
    const saved: SavedSearchQuery = {
      channel: 'sale',
      places: [
        { suburb: 'Pakenham', state: 'VIC', postcode: '3810' },
        { suburb: 'Berwick', state: 'VIC' },
      ],
      radiusKm: 10,
      propertyTypes: ['house', 'townhouse'],
      bedrooms: 3,
    };
    const path = savedQueryToPath(saved);
    expect(path).not.toContain('lat=');
    expect(parse(path.split('?')[1] ?? '')).toEqual(saved);
  });

  it('says every suburb in words', () => {
    expect(
      describeSavedQuery({
        channel: 'sale',
        suburb: 'Pakenham',
        places: [{ suburb: 'Berwick' }, { suburb: 'Officer' }],
        radiusKm: 10,
        propertyTypes: ['house', 'townhouse'],
      }),
    ).toBe('houses or townhouses for sale in Pakenham, Berwick or Officer and within 10 km of each');
  });
});
