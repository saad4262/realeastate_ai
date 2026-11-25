import { describe, expect, it } from 'vitest';
import { parseSearchText } from './search-text';

const read = (text: string) => {
  const { understood: _u, rest: _r, ...rest } = parseSearchText(text);
  // Only the fields that were set, so each case states exactly what it expects.
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length && v !== rest.places)));
};

/** ADR 0101: the sentence a buyer types, read without a model. */
describe('parseSearchText: distance', () => {
  it.each([
    ['10 km pakenham', 10, ['pakenham']],
    ['pakenham 10km', 10, ['pakenham']],
    ['pakenham within 10 km', 10, ['pakenham']],
    ['within 10 km of Pakenham', 10, ['Pakenham']],
    ['10km from berwick', 10, ['berwick']],
    ['10km radius of berwick', 10, ['berwick']],
    ['+20km officer', 20, ['officer']],
    ['5 kms around 3810', 5, ['3810']],
    ['Within 12 kilometres of Officer VIC', 12, ['Officer VIC']],
    ['near 3810 5 km', 5, ['3810']],
    ['within 500m of Pakenham', 1, ['Pakenham']],
    ['within 300 km of Pakenham', 50, ['Pakenham']],
  ])('"%s" → %d km around %j', (text, km, places) => {
    const p = parseSearchText(text);
    expect(p.km).toBe(km);
    expect(p.places).toEqual(places);
    expect(p.understood).toBe(true);
  });
});

describe('parseSearchText: the whole sentence', () => {
  it('reads a full brief and leaves only the place', () => {
    expect(read('pakenham 10km 3 bed house under 800k')).toEqual({
      places: ['pakenham'], km: 10, beds: 3, types: ['house'], priceTo: 800_000,
    });
  });

  it('reads rooms, cars, a range and several types', () => {
    expect(read('3 bed 2 bath 2 car townhouse or unit in Berwick $600k-$900k')).toEqual({
      places: ['Berwick'], beds: 3, baths: 2, cars: 2, types: ['townhouse', 'unit'], priceFrom: 600_000, priceTo: 900_000,
    });
  });

  it('reads several places', () => {
    expect(parseSearchText('house in Berwick or Officer, Clyde North').places).toEqual(['Berwick', 'Officer', 'Clyde North']);
    expect(parseSearchText('4 bed home pakenham and berwick within 5km').places).toEqual(['pakenham', 'berwick']);
  });

  it('reads rent, a weekly price and "new"', () => {
    expect(read('2 bed apartment for rent richmond under $600 pw')).toEqual({
      places: ['richmond'], beds: 2, types: ['apartment'], channel: 'rent', priceTo: 600,
    });
    expect(read('brand new house and land officer')).toEqual({ places: ['officer'], newBuild: true });
  });

  it('reads words for numbers and the common shorthands', () => {
    expect(read('three bedroom house with a double garage')).toEqual({ places: [], beds: 3, cars: 2, types: ['house'] });
    expect(read('4br 2.5 bath clyde')).toEqual({ places: ['clyde'], beds: 4, baths: 2 });
    expect(read('2-3 bed unit 3806')).toEqual({ places: ['3806'], beds: 2, types: ['unit'] });
  });

  it('reads the kinds of price people type', () => {
    expect(parseSearchText('pakenham 1.2m').priceTo).toBe(1_200_000);
    expect(parseSearchText('pakenham over $750,000').priceFrom).toBe(750_000);
    expect(parseSearchText('between 500k and 700k berwick')).toMatchObject({ priceFrom: 500_000, priceTo: 700_000 });
    expect(parseSearchText('600-900k officer')).toMatchObject({ priceFrom: 600_000, priceTo: 900_000 });
    expect(parseSearchText('budget 650000 clyde')).toMatchObject({ priceTo: 650_000, places: ['clyde'] });
  });
});

describe('parseSearchText: what it must leave alone', () => {
  it.each([
    ['Pakenham', ['Pakenham']],
    ['3810', ['3810']],
    ['Bondi Beach NSW 2026', ['Bondi Beach NSW 2026']],
    ['14 Rogers Street, Pakenham', ['14 Rogers Street', 'Pakenham']],
    ['The Basin', ['The Basin']],
    ['Forest Hill', ['Forest Hill']],
    ['Highland Park', ['Highland Park']],
  ])('"%s" is only a place', (text, places) => {
    const p = parseSearchText(text);
    expect(p.places).toEqual(places);
    expect(p.understood).toBe(false);
  });

  it('never reads a postcode, a street number or a small number as a price', () => {
    for (const text of ['3810', '14 Rogers Street', 'unit 5 pakenham', '10 mins walk from station', '3810 and 3806']) {
      const p = parseSearchText(text);
      expect(p.priceFrom, text).toBeUndefined();
      expect(p.priceTo, text).toBeUndefined();
    }
  });

  it('refuses an absurd price and a backwards range', () => {
    expect(parseSearchText('pakenham 900m').priceTo).toBeUndefined();
    expect(parseSearchText('900k-600k pakenham').priceFrom).toBeUndefined();
  });

  it('leaves words it does not know for the place lookup (and, later, the AI)', () => {
    expect(read('3 bed house with a pool near a good school in berwick')).toEqual({
      places: ['pool near a good school in berwick'], beds: 3, types: ['house'],
    });
  });

  it('drops filler that is not a place', () => {
    expect(parseSearchText('show me homes').places).toEqual([]);
    expect(parseSearchText('looking for a 3 bed house near').places).toEqual([]);
  });
});

/** Refining from the results bar (ADR 0101): the same box, so the same reading. */
describe('parseSearchText: refining a search', () => {
  it.each([
    ['add clyde', { places: ['clyde'] }],
    ['also officer', { places: ['officer'] }],
    ['make it 4 bed', { places: [], beds: 4 }],
    ['change to under 700k', { places: [], priceTo: 700_000 }],
    ['only townhouses', { places: [], types: ['townhouse'] }],
  ])('"%s"', (text, want) => {
    expect(parseSearchText(text)).toMatchObject(want);
  });
});
