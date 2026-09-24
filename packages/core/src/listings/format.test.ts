import { describe, expect, it } from 'vitest';
import type { PublicListing } from './search-listings';
import { addressLines, channelLabel, distanceLabel, landLabel, listedLabel, priceBoundLabel, priceLabel, specLine } from './format';

function listing(over: Partial<PublicListing>): PublicListing {
  return {
    id: 'l-1',
    propertyId: 'p-1',
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

describe('the labels a property page needs', () => {
  it('names the channel', () => {
    expect(channelLabel('sale')).toBe('For sale');
    expect(channelLabel('rent')).toBe('For rent');
    expect(channelLabel('sold')).toBe('Sold');
    expect(channelLabel('leased')).toBe('Leased');
  });

  it('formats land size, and says nothing when there is none', () => {
    expect(landLabel(185)).toBe('185 m²');
    expect(landLabel(1250.4)).toBe('1,250 m²');
    expect(landLabel(null)).toBeNull();
    // 0 m² is not a fact about a property, it is an empty field.
    expect(landLabel(0)).toBeNull();
  });

  it('gives the listed date absolutely, never relatively', () => {
    const label = listedLabel(new Date('2026-09-12T03:00:00Z'));
    // The exact wording matters less than this: no "ago", no "days", nothing
    // that is computed from now() and therefore wrong once cached.
    expect(label).toMatch(/^Listed \d{1,2} \w+ \d{4}$/);
    expect(label).not.toMatch(/ago|today|yesterday/i);
    expect(listedLabel(null)).toBeNull();
    expect(listedLabel(new Date('nonsense'))).toBeNull();
  });

  it('splits the address without saying the suburb twice', () => {
    const lines = addressLines({
      address: '12/1A Rogers Street, Pakenham, VIC 3810',
      suburb: 'Pakenham',
      state: 'VIC',
      postcode: '3810',
    });
    expect(lines.street).toBe('12/1A Rogers Street');
    expect(lines.locality).toBe('Pakenham, VIC 3810');
  });

  it('falls back to the locality when there is no street', () => {
    // formatAddress drops empty street parts, so a property with only a suburb
    // has an address that IS the locality. An empty street line above it would
    // render as a missing heading.
    const lines = addressLines({
      address: 'Pakenham, VIC 3810',
      suburb: 'Pakenham',
      state: 'VIC',
      postcode: '3810',
    });
    expect(lines.street).toBe('Pakenham, VIC 3810');
  });
});
