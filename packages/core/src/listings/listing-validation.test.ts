import { describe, expect, it } from 'vitest';
import {
  createListingInputSchema,
  listingDraftSchema,
  propertyDraftSchema,
} from './listing-schema';

/**
 * The rules that exist because this database had junk in it — and the ones
 * that were taken back out again.
 *
 * Every case here is a real value that was live on the public site, not an
 * invented worst case. Some are now ACCEPT cases: the headline and
 * description shape rules were removed at the owner's request, on the view
 * that an agency writing its own copy should not be argued with. Those tests
 * were kept and flipped rather than deleted, so the decision is recorded
 * where the next person will actually look.
 *
 * What is still refused is bounds, not taste: a length the layout cannot
 * hold, a price range the wrong way round, a rental with no rent. The
 * "accepts" cases matter just as much — a rule that refused "Contact agent"
 * or "Offers over $1.45m" would be worse than the junk it caught.
 */

const validProperty = {
  suburb: 'Pakenham',
  state: 'VIC' as const,
  postcode: '3810',
};

const validListing = {
  channel: 'sale' as const,
  headline: 'Three-bedroom home close to the station',
  priceDisplay: 'Offers over $700,000',
};

const draft = (listing: Record<string, unknown>) =>
  listingDraftSchema.safeParse({ ...validListing, ...listing });

const firstMessage = (r: ReturnType<typeof draft>) =>
  r.success ? null : r.error.issues[0]?.message ?? '';

describe('headline', () => {
  /**
   * These three were live on the public site, and the schema used to refuse
   * them. It does not any more — see the note on `headlineSchema`. They are
   * kept as ACCEPT cases rather than deleted, so the change of mind is
   * visible here rather than only in a diff: if any of these starts failing
   * again, somebody has quietly put the shape rules back.
   */
  it.each(['dfs', 'dfsdsf', 'jdsfjdfjl', 'aaaaaaaaaaaaaaaaaaaa'])('accepts %j', (headline) => {
    expect(draft({ headline }).success).toBe(true);
  });

  it.each([
    'Sunlit Bondi apartment near the beach',
    'Previous sale',
    'Family home on a quiet block',
  ])('accepts %j', (headline) => {
    expect(draft({ headline }).success).toBe(true);
  });

  /** Trimmed first, so padding is not a headline. */
  it('rejects whitespace only', () => {
    expect(draft({ headline: '     ' }).success).toBe(false);
  });

  it('rejects an empty headline — the card needs a title', () => {
    expect(draft({ headline: '' }).success).toBe(false);
  });

  /** The bound that stayed: the card and the email subject are sized for it. */
  it('rejects over 200 characters', () => {
    expect(draft({ headline: 'a'.repeat(201) }).success).toBe(false);
  });

  it('accepts exactly 200', () => {
    expect(draft({ headline: 'a'.repeat(200) }).success).toBe(true);
  });
});

describe('priceDisplay', () => {
  // Real values from three live listings. The first displayed twenty-three
  // million while its searchable range said $34,443.
  it.each(['23443342', '332432322', '9320334343324', '1450000', '1,450,000'])(
    'rejects bare digits %j',
    (priceDisplay) => {
      const result = draft({ priceDisplay });
      expect(result.success).toBe(false);
      expect(firstMessage(result)).toMatch(/as a buyer should read it/i);
    },
  );

  it.each([
    'Offers over $1.45m',
    'Sold $1.20m',
    'Contact agent',
    '$720,000 – $780,000',
    'Auction 12 April',
    'Price on application',
  ])('accepts %j', (priceDisplay) => {
    expect(draft({ priceDisplay }).success).toBe(true);
  });
});

describe('a sale listing needs a price', () => {
  it('rejects a sale with no price at all', () => {
    const result = draft({ priceDisplay: undefined });
    expect(result.success).toBe(false);
    expect(firstMessage(result)).toMatch(/needs a price/i);
  });

  it.each([
    { priceDisplay: 'Contact agent' },
    { priceDisplay: undefined, priceFrom: 700_000 },
    { priceDisplay: undefined, priceTo: 780_000 },
  ])('accepts %j', (patch) => {
    expect(draft(patch).success).toBe(true);
  });

  it('does not apply to a rental, which is governed by rentPw', () => {
    expect(
      draft({ channel: 'rent', priceDisplay: undefined, rentPw: 650 }).success,
    ).toBe(true);
  });
});

describe('room counts', () => {
  const withProperty = (property: Record<string, unknown>) =>
    createListingInputSchema.safeParse({
      property: { ...validProperty, ...property },
      listing: validListing,
    });

  // The live listing that claimed 23 bedrooms, 32 bathrooms and 32 car spaces.
  it.each([
    ['bedrooms', { bedrooms: 23 }],
    ['bathrooms', { bathrooms: 32 }],
    ['carSpaces', { carSpaces: 32 }],
  ])('rejects %s beyond what a dwelling has', (_label, property) => {
    expect(withProperty(property).success).toBe(false);
  });

  it('accepts a large but real house', () => {
    expect(withProperty({ bedrooms: 8, bathrooms: 6, carSpaces: 4 }).success).toBe(true);
  });

  it('accepts zero, which a block of land has', () => {
    expect(withProperty({ bedrooms: 0, bathrooms: 0, carSpaces: 0 }).success).toBe(true);
  });
});

describe('property type is a vocabulary, not a text box', () => {
  const type = (propertyType: unknown) =>
    propertyDraftSchema.safeParse({ ...validProperty, propertyType });

  // Both were live, and both were being offered to the public as filters
  // because the search dropdown is built from the distinct values in this
  // column.
  it.each(['sfd', '2jkads', 'Hosue', 'family home'])('rejects %j', (v) => {
    expect(type(v).success).toBe(false);
  });

  it.each(['house', 'apartment', 'townhouse', 'land', 'other'])('accepts %j', (v) => {
    expect(type(v).success).toBe(true);
  });

  it('normalises capitalisation so the column has one spelling per type', () => {
    // "House" and "house" were two different kinds of building to the filter.
    for (const v of ['House', 'HOUSE', '  house ']) {
      const parsed = type(v);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.propertyType).toBe('house');
    }
  });

  it('stays optional — a listing without a type is not an error', () => {
    expect(propertyDraftSchema.safeParse(validProperty).success).toBe(true);
  });
});

describe('description', () => {
  /** Refused once, accepted now. Same reversal as the headline above. */
  it.each(['asd', 'dfg', 'test copy'])('accepts %j', (description) => {
    expect(draft({ description }).success).toBe(true);
  });

  it('accepts a real sentence', () => {
    expect(
      draft({ description: 'Two-bed apartment with a north aspect and a courtyard.' }).success,
    ).toBe(true);
  });

  it('stays optional — plenty of listings have no body copy', () => {
    expect(draft({ description: undefined }).success).toBe(true);
  });

  it('accepts an empty string', () => {
    expect(draft({ description: '' }).success).toBe(true);
  });

  /** The only bound left: this column is read whole by the edit form. */
  it('rejects over 20,000 characters', () => {
    expect(draft({ description: 'a'.repeat(20_001) }).success).toBe(false);
  });
});
