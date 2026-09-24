import { describe, expect, it } from 'vitest';
import type { PublicListing } from './search-listings';
import { distanceLabel, priceBoundLabel, priceLabel, specLine } from './format';

function listing(over: Partial<PublicListing>): PublicListing {
  return {
    id: 'l-1',
    address: '8 Henry St, Pakenham VIC 3810',
    suburb: 'Pakenham',
    state: 'VIC',
    postcode: '3810',
    channel: 'sale',
    headline: null,
    description: null,
    priceDisplay: null,
    priceFrom: null,
    priceTo: null,
    rentPw: null,
    bedrooms: null,
    bathrooms: null,
    carSpaces: null,
    propertyType: null,
    landAreaSqm: null,
    latitude: null,
    longitude: null,
    distanceKm: null,
    agencyName: 'Saadiii',
    agents: [],
    publishedAt: null,
    ...over,
  };
}

describe('priceLabel', () => {
  it("prefers the agency's own copy over the numeric range", () => {
    // Non-negotiable #6: price_display is shown, never parsed. The model is
    // handed this string and copies it, so a range that disagreed with the
    // copy would be a price the database never quoted.
    const row = listing({ priceDisplay: 'Offers over $1.2M', priceFrom: 1_150_000, priceTo: 1_300_000 });
    expect(priceLabel(row)).toBe('Offers over $1.2M');
  });

  it('formats a range when there is no copy', () => {
    const row = listing({ priceFrom: 750_000, priceTo: 820_000 });
    expect(priceLabel(row)).toBe('$750,000 – $820,000');
  });

  it('formats a single bound', () => {
    expect(priceLabel(listing({ priceFrom: 750_000 }))).toBe('$750,000');
  });

  it('reads rent_pw for a rental, never the sale columns', () => {
    // Rentals never set price_from; reading it here is the bug that made every
    // rent filter match nothing.
    const row = listing({ channel: 'rent', rentPw: 650, priceFrom: 900_000 });
    expect(priceLabel(row)).toBe('$650 per week');
  });

  it('says "Contact agent" when there is no number at all', () => {
    expect(priceLabel(listing({}))).toBe('Contact agent');
    expect(priceLabel(listing({ channel: 'rent' }))).toBe('Contact agent');
  });
});

describe('specLine', () => {
  it('joins only the specs that exist', () => {
    const row = listing({ bedrooms: 3, bathrooms: 2, carSpaces: 2, propertyType: 'House' });
    expect(specLine(row)).toBe('3 bed · 2 bath · 2 car · House');
  });

  it('keeps a zero, which is a fact rather than a gap', () => {
    expect(specLine(listing({ bedrooms: 0, carSpaces: 0 }))).toBe('0 bed · 0 car');
  });

  it('is empty when nothing is known', () => {
    expect(specLine(listing({}))).toBe('');
  });
});

describe('distanceLabel', () => {
  it('is null when the search had no centre', () => {
    // So the model is never handed a distance from nowhere to repeat.
    expect(distanceLabel(null)).toBeNull();
  });

  it('reads to one decimal', () => {
    expect(distanceLabel(4.23)).toBe('4.2 km away');
    expect(distanceLabel(0)).toBe('0.0 km away');
  });
});

describe('priceBoundLabel', () => {
  it('says per week for a rental bound', () => {
    expect(priceBoundLabel(900, true)).toBe('$900 per week');
    expect(priceBoundLabel(800_000, false)).toBe('$800,000');
  });
});
