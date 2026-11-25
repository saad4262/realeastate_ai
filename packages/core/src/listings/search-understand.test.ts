import { describe, expect, it } from 'vitest';
import { numbersIn, understandSearch, verifyUnderstood } from './search-understand';

/** ADR 0101 part 2: a model's reading is used only where it checks out against the user's own words. */
describe('verifyUnderstood', () => {
  const TEXT = 'family home with a pool near a good school in berwick or officer, three bedrooms, under 900k';

  it('takes the places, keywords and gaps the sentence really has', () => {
    const u = verifyUnderstood(
      {
        places: ['Berwick', 'Officer'],
        types: ['house'],
        beds: 3,
        price_to: 900000,
        keywords: ['pool'],
        not_searchable: ['near a good school'],
      },
      TEXT,
    );
    expect(u).toMatchObject({
      places: ['Berwick', 'Officer'],
      types: ['house'],
      beds: 3,
      priceTo: 900_000,
      keywords: ['pool'],
      notSearchable: ['near a good school'],
      understood: true,
    });
  });

  it('drops every number the user did not write', () => {
    const u = verifyUnderstood({ places: ['Berwick'], beds: 4, baths: 2, price_to: 2_000_000, km: 15 }, 'house in berwick with a pool');
    expect(u.beds).toBeUndefined();
    expect(u.baths).toBeUndefined();
    expect(u.priceTo).toBeUndefined();
    expect(u.km).toBeUndefined();
  });

  it('lets the rules win wherever they read something', () => {
    const u = verifyUnderstood({ places: ['Pakenham'], beds: 4, km: 20, types: ['unit'] }, 'pakenham 10km 3 bed house, 4 car, 20 min to the station');
    expect(u).toMatchObject({ km: 10, beds: 3, types: ['house'] });
  });

  it('keeps no keyword or gap the user did not type', () => {
    const u = verifyUnderstood({ places: ['Berwick'], keywords: ['pool', 'tennis court'], not_searchable: ['great schools'] }, 'berwick with a pool');
    expect(u.keywords).toEqual(['pool']);
    expect(u.notSearchable).toEqual([]);
  });

  it('survives an answer that is half wrong, or not an answer at all', () => {
    const u = verifyUnderstood({ places: 'Berwick', types: ['castle', 'House'], beds: 'three', channel: 'lease', keywords: [7, 'pool'] }, 'berwick house with a pool');
    // Places that are not a list fall back to the rules' leftover, which the geocoder then checks.
    expect(u).toMatchObject({ places: ['berwick with a pool'], types: ['house'], keywords: ['pool'] });
    expect(u.beds).toBeUndefined();
    expect(u.channel).toBeUndefined();
    expect(verifyUnderstood('nonsense', 'pakenham 3 bed').beds).toBe(3);
    expect(verifyUnderstood(null, 'pakenham').places).toEqual(['pakenham']);
  });

  it('refuses a backwards price range', () => {
    const u = verifyUnderstood({ places: ['Clyde'], price_from: 900000, price_to: 600000 }, 'clyde 600k 900k');
    expect(u.priceFrom).toBeUndefined();
    expect(u.priceTo).toBeUndefined();
  });
});

describe('numbersIn', () => {
  it('knows the numbers and the money a sentence holds, and nothing else', () => {
    const n = numbersIn('three bed, 2 bath, under $1.2m or 950k, postcode 3810');
    for (const v of [3, 2, 1_200_000, 950_000, 3810]) expect(n.has(v)).toBe(true);
    for (const v of [4, 1_000_000, 900_000]) expect(n.has(v)).toBe(false);
  });
});

describe('understandSearch', () => {
  it('sends the sentence trimmed and capped, and checks what comes back', async () => {
    const seen: string[] = [];
    const u = await understandSearch(`  berwick   with a pool ${'x'.repeat(400)}`, async ({ text }) => {
      seen.push(text);
      return { places: ['Berwick'], keywords: ['pool'], beds: 9 };
    });
    expect(seen[0]!.length).toBe(300);
    expect(seen[0]!.startsWith('berwick with a pool')).toBe(true);
    expect(u).toMatchObject({ places: ['Berwick'], keywords: ['pool'] });
    expect(u.beds).toBeUndefined();
  });

  it('passes a model failure up, so the caller can fall back to the rules', async () => {
    await expect(understandSearch('berwick', async () => { throw new Error('down'); })).rejects.toThrow('down');
  });
});
