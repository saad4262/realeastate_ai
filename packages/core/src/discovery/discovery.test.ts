import { describe, expect, it } from 'vitest';
import type { DbOrTx } from '@repo/db';
import { askSummary, differencesOf, profileAsk, rankSuggestions, type CandidateRow, type DiscoveryAsk } from './match';
import { discoverToolResult } from './tool';
import { clearHiddenHomes, DiscoveryError, forYou, hiddenHomes, hideHome, showHomeAgain } from './discovery';
import type { ProfileFacts } from '../profile/derive';

// The mock's profile: Pakenham and Officer, for sale, up to $800,000, 3 bedrooms, a house.
const profile: DiscoveryAsk = { from: 'profile', channel: 'sale', suburbs: ['pakenham', 'officer'], state: null, propertyTypes: ['house'], bedrooms: 3, priceTo: 800_000, priceNear: null };

let n = 0;
const row = (over: Partial<CandidateRow>): CandidateRow => {
  n += 1;
  return {
    listingId: `l${n}`,
    propertyId: `p${n}`,
    address: `${n} Test Road, Pakenham`,
    suburb: 'Pakenham',
    state: 'VIC',
    price: 'Offers over $760,000',
    topPrice: 760_000,
    bedrooms: 3,
    bathrooms: 2,
    propertyType: 'house',
    inSuburb: true,
    nearName: 'Pakenham',
    nearMetres: 800,
    publishedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
};

describe('Discovery AI: what a card may differ on (decision 2)', () => {
  it('allows one difference — a suburb within 5 km, one more bedroom, or no price — and says which', () => {
    expect(differencesOf(row({}), profile)).toEqual([]);
    expect(differencesOf(row({ inSuburb: false, suburb: 'Clyde North', nearName: 'Officer', nearMetres: 4200 }), profile)).toEqual([{ kind: 'nearby', suburb: 'Clyde North', from: 'Officer', metres: 4200 }]);
    expect(differencesOf(row({ bedrooms: 4 }), profile)).toEqual([{ kind: 'one_more_bedroom', bedrooms: 4, wanted: 3 }]);
    expect(differencesOf(row({ topPrice: null, price: 'Contact agent' }), profile)).toEqual([{ kind: 'no_price' }]);
  });

  it('never goes over budget, past 5 km, to another kind, or two bedrooms over', () => {
    expect(differencesOf(row({ topPrice: 800_001 }), profile)).toBeNull();
    expect(differencesOf(row({ inSuburb: false, nearMetres: 5_001 }), profile)).toBeNull();
    expect(differencesOf(row({ inSuburb: false, nearMetres: null }), profile)).toBeNull();
    expect(differencesOf(row({ propertyType: 'apartment' }), profile)).toBeNull();
    expect(differencesOf(row({ propertyType: null }), profile)).toBeNull();
    expect(differencesOf(row({ bedrooms: 5 }), profile)).toBeNull();
    expect(differencesOf(row({ bedrooms: 2 }), profile)).toBeNull();
    expect(differencesOf(row({ bedrooms: null }), profile)).toBeNull();
  });

  it('a home at exactly the budget fits', () => {
    expect(differencesOf(row({ topPrice: 800_000 }), profile)).toEqual([]);
  });

  it('orders fewest differences, then nearest, then newest; two differences are dropped; one card per address', () => {
    const far = row({ inSuburb: false, suburb: 'Clyde North', nearName: 'Officer', nearMetres: 4200 });
    const near = row({ inSuburb: false, suburb: 'Beaconsfield', nearName: 'Officer', nearMetres: 2000 });
    const exactOld = row({ publishedAt: new Date('2026-09-01T00:00:00Z') });
    const exactNew = row({ publishedAt: new Date('2026-10-20T00:00:00Z') });
    const twoOff = row({ inSuburb: false, nearName: 'Officer', nearMetres: 1000, bedrooms: 4 });
    const sameAddress = row({ propertyId: exactNew.propertyId, listingId: 'other-ad' });
    const ranked = rankSuggestions([far, twoOff, exactOld, near, exactNew, sameAddress], profile, 12);
    expect(ranked.map((s) => s.listingId)).toEqual([exactNew.listingId, exactOld.listingId, near.listingId, far.listingId]);
    expect(ranked[3]!.differenceText).toBe('Clyde North · 4.2 km from Officer');
    expect(ranked[0]!.matches).toEqual(['Pakenham', '3 bed', 'house', 'under $800,000']);
  });

  it('skips addresses the caller excludes and keeps to the limit', () => {
    const a = row({});
    const b = row({});
    expect(rankSuggestions([a, b], profile, 12, new Set([a.propertyId])).map((s) => s.listingId)).toEqual([b.listingId]);
    expect(rankSuggestions([a, b], profile, 1)).toHaveLength(1);
  });

  it('Similar homes: within 10% of the listing’s price, and says so; the difference reads from the listing', () => {
    const similar: DiscoveryAsk = { from: 'listing', channel: 'sale', suburbs: ['pakenham'], state: 'VIC', propertyTypes: ['house'], bedrooms: 3, priceTo: null, priceNear: 690_000 };
    expect(differencesOf(row({ topPrice: 760_000 }), similar)).toBeNull(); // 10.1% over
    expect(differencesOf(row({ topPrice: 621_000 }), similar)).toEqual([]);
    const [card] = rankSuggestions([row({ topPrice: 700_000, bedrooms: 4 })], similar, 6);
    expect(card!.differenceText).toBe('4 bed · one more');
    expect(card!.matches).toEqual(['Pakenham', 'house', 'within 10% of the price']);
  });
});

describe('Discovery AI: the profile is the only personal input (decision 1)', () => {
  const facts = (over: Partial<ProfileFacts>): ProfileFacts => ({ suburbs: null, channel: null, priceTo: null, bedrooms: null, propertyTypes: null, ...over });
  it('needs at least one suburb', () => {
    expect(profileAsk(facts({}))).toEqual({ gap: 'no_suburbs' });
  });
  it('takes the facts as they stand, the buyer’s edits included, and assumes nothing else', () => {
    const built = profileAsk(facts({ suburbs: { value: ['Pakenham', 'Officer'], by: 'you', sources: [] }, priceTo: { value: 800_000, by: 'learnt', sources: [] }, propertyTypes: { value: ['House'], by: 'learnt', sources: [] } }));
    expect(built).toEqual({ ask: { from: 'profile', channel: 'sale', suburbs: ['pakenham', 'officer'], state: null, propertyTypes: ['house'], bedrooms: null, priceTo: 800_000, priceNear: null } });
    if ('ask' in built) expect(askSummary(built.ask)).toEqual([
      { label: 'Suburbs', value: 'Pakenham, Officer' },
      { label: 'Buying', value: 'For sale' },
      { label: 'Up to', value: '$800,000' },
      { label: 'Kind', value: 'Houses' },
    ]);
  });
});

describe('Discovery AI: the guide’s result (decision 9)', () => {
  it('says why there is nothing, rather than guessing', () => {
    expect(discoverToolResult({ state: 'profile_off' })).toMatchObject({ found: false, reason: 'profile_off' });
    expect(discoverToolResult({ state: 'gap', gap: 'no_suburbs' })).toMatchObject({ found: false, reason: 'no_suburbs' });
    expect(discoverToolResult(null)).toMatchObject({ found: false, reason: 'listing_not_public' });
  });
  it('lists homes not for sale apart, labelled with their sale, and forbids a value', () => {
    const out = discoverToolResult({
      state: 'ready',
      ask: profile,
      summary: askSummary(profile),
      homes: rankSuggestions([row({})], profile, 12),
      notForSale: [{ propertyId: 'p9', address: '31 Hilltop Road, Pakenham', suburb: 'Pakenham', state: 'VIC', bedrooms: 3, propertyType: 'house', soldOn: new Date('2024-09-10'), soldText: 'Sept 2024' }],
    });
    if (!out.found) throw new Error('expected found');
    expect(out.notForSale).toEqual([{ propertyId: 'p9', line: '31 Hilltop Road, Pakenham — not for sale; sold on this site in Sept 2024', page: '/property/p9' }]);
    expect(out.rules).toMatch(/never guess a value/i);
    expect(out.page).toBe('/account/for-you');
  });
});

describe('Discovery AI: hidden homes are the owner’s only (decision 4)', () => {
  it('refuses a visitor with no account before touching the database', async () => {
    const nobody = { userId: '' };
    for (const call of [() => forYou({} as DbOrTx, nobody), () => hideHome({} as DbOrTx, nobody, 'p'), () => showHomeAgain({} as DbOrTx, nobody, 'p'), () => hiddenHomes({} as DbOrTx, nobody), () => clearHiddenHomes({} as DbOrTx, nobody)]) {
      await expect(call()).rejects.toBeInstanceOf(DiscoveryError);
    }
  });
});
