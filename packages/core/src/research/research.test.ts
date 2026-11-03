import { describe, expect, it } from 'vitest';
import { checkResearch, compareRecords, explainRecords, passesVerdictRule, researchData, runResearch, ResearchError, suburbRecords } from './assist';
import { censusView, gatedMedian, MEDIAN_MIN_SALES, share, type SuburbProfile } from './suburb';
import type { HomeRow } from './homes';

describe('Suburb AI (ADR 0080, C5)', () => {
  it('a median only with enough sales behind it (decision 2)', () => {
    expect(MEDIAN_MIN_SALES).toBe(10);
    expect(gatedMedian(745_000.4, 10)).toEqual({ value: 745_000, sales: 10 });
    expect(gatedMedian(745_000, 9)).toBeNull();
    expect(gatedMedian(null, 40)).toBeNull();
  });

  it('census shares are computed from the counts, in code (#4)', () => {
    expect(share(15_936, 18_448)).toBe(86);
    expect(share(5, null)).toBeNull();
    expect(share(5, 0)).toBeNull();
    const c = censusView({ salCode: 'SAL22027', censusYear: 2021, name: 'Pakenham', nameKey: 'pakenham', state: 'VIC', population: 54118, dwellings: 18448, separateHouses: 15936, semiDetached: 2349, flats: 105, ownedOutright: 3445, ownedMortgage: 8536, rented: 5679, tenureTotal: 18448, medianRentWeekly: 351, medianMortgageMonthly: 1733, avgHouseholdSize: '2.80' });
    expect(c).toMatchObject({ separateHousePct: 86, ownedMortgagePct: 46, rentedPct: 31, avgHouseholdSize: 2.8 });
  });

  it('records say the figures are this site’s, and a thin suburb says too few for a median', () => {
    const p: SuburbProfile = { suburb: 'Clyde North', state: 'VIC', forSale: 6, forRent: 1, salesInWindow: 4, medianSold: null, medianDays: null, recentSales: [], census: null };
    const r = suburbRecords(p);
    expect(r[0]).toEqual({ ref: 'S1', text: 'On this site now: 6 for sale and 1 for rent in Clyde North.' });
    expect(r[1]!.text).toBe('Sales on this site in the last 12 months: 4 — too few for a median.');
    expect(r.some((x) => x.ref.startsWith('C'))).toBe(false);
  });
});

describe('never a verdict (decision 1)', () => {
  it('drops a line that values, judges or predicts, whatever it cites', () => {
    for (const bad of ['B is better value than A.', 'This is a good investment.', 'Prices will grow here.', 'A looks overpriced.', 'You should buy C.', 'C is the best of the three.', 'Expect capital growth.']) {
      expect(passesVerdictRule(bad), bad).toBe(false);
    }
    for (const ok of ['A has 4 bedrooms on 612 m².', 'B has been on the market for 41 days.']) expect(passesVerdictRule(ok), ok).toBe(true);
  });

  it('keeps cited lines whose figures are in their records; drops a verdict or an invented figure', () => {
    const records = [{ ref: 'A', text: '14 Station St VIC: $760,000 – $800,000; 4 bed; land 612 m².' }, { ref: 'B', text: '3 Sample Ln VIC: Offers over $720,000; 41 days on the market.' }];
    const kept = checkResearch(
      [
        { text: 'A has 4 bedrooms on 612 m².', refs: ['A'] },
        { text: 'B is better value.', refs: ['B'] },
        { text: 'B would sell for $700,000.', refs: ['B'] },
        { text: 'B has been on the market for 41 days.', refs: ['B'] },
      ],
      records,
    );
    expect(kept.map((k) => k.text)).toEqual(['A has 4 bedrooms on 612 m².', 'B has been on the market for 41 days.']);
  });
});

const home = (over: Partial<HomeRow> = {}): HomeRow => ({ listingId: 'l1', propertyId: 'p1', address: '14 Station St, Officer', suburb: 'Officer', state: 'VIC', channel: 'sale', price: '$760,000 – $800,000', priceForDuty: 800_000, bedrooms: 4, bathrooms: 2, carSpaces: 2, landAreaSqm: 612, propertyType: 'House', daysOnMarket: 3, priceChanges: [], lastSale: null, stampDuty: { status: 'estimate', state: 'VIC', duty: 43_070, generalDuty: 43_070, applied: 'general', exact: true, notes: [], sources: [] }, ...over });

describe('Comparison AI and Property Analyst', () => {
  it('each home is one record, its column letter its reference, every figure from SQL', () => {
    const r = compareRecords([home(), home({ listingId: 'l2', address: '3 Sample Ln, Pakenham', price: 'Offers over $720,000', priceChanges: ['Offers over $750,000 → Offers over $720,000'], daysOnMarket: 41, stampDuty: null })]);
    expect(r.map((x) => x.ref)).toEqual(['A', 'B']);
    expect(r[0]!.text).toBe('14 Station St, Officer VIC: $760,000 – $800,000; 4 bed, 2 bath, 2 car; land 612 m²; 3 days on the market; no price changes recorded; stamp duty estimate $43,070.');
    expect(r[1]!.text).toContain('price changes: Offers over $750,000 → Offers over $720,000');
  });

  it('an explanation: the home (P), its history (H…), its comparables (K…) — listed, never averaged', () => {
    const r = explainRecords(home(), [{ ref: 'R2', when: '14 Mar 2019', text: 'Sold for $455,000.' }], [{ listingId: 'k', address: '7 Test Road', bedrooms: 4, landAreaSqm: 580, standing: 'sold', price: 'Sold $781,000' }]);
    expect(r.map((x) => x.ref)).toEqual(['P', 'H1', 'K1']);
    expect(r[2]!.text).toBe('Comparable: 7 Test Road, 4 bed, 580 m² — Sold $781,000.');
  });

  it('a comparison needs 2 to 4 homes, checked before anything is read; no AI, no reads', async () => {
    await expect(researchData({} as never, { kind: 'compare', listingIds: ['a'], buyer: 'home' })).rejects.toBeInstanceOf(ResearchError);
    await expect(researchData({} as never, { kind: 'compare', listingIds: ['a', 'b', 'c', 'd', 'e'], buyer: 'home' })).rejects.toBeInstanceOf(ResearchError);
    await expect(runResearch({} as never, null, { kind: 'suburb', state: 'VIC', suburb: 'Pakenham' })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
