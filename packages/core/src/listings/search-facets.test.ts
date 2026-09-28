import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { priceLadder, searchFacets } from './search-facets';

/**
 * The rule every filter option has to obey.
 *
 * A dropdown entry that cannot return a result is worse than a missing one:
 * it looks like a working control, it empties the page, and the visitor
 * concludes the portal has nothing rather than that the filter was fiction.
 * Four of the six controls on /search were in that state — the sale price
 * ladder started at $750,000 against a database whose dearest listing was
 * $50,000 — which is what these tests exist to stop coming back.
 */

function fakeDb(row: Record<string, unknown> | undefined) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'where', 'orderBy', 'groupBy']) {
    chain[m] = () => chain;
  }
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(row ? [row] : []).then(res);
  return chain as unknown as Db;
}

describe('facets come back as numbers, not the strings Postgres sends', () => {
  it('converts counts, numerics and aggregated arrays', async () => {
    const db = fakeDb({
      suburbs: ['Pakenham', 'Officer'],
      saleTotal: '3',
      saleBedrooms: ['3', '4'],
      saleBathrooms: ['2.0', '3.0'],
      saleCarSpaces: ['1', '2'],
      saleTypes: ['house'],
      salePriceMin: '23000.00',
      salePriceMax: '50000.00',
      rentTotal: '0',
      rentBedrooms: null,
      rentBathrooms: null,
      rentCarSpaces: null,
      rentTypes: null,
      rentPriceMin: null,
      rentPriceMax: null,
    });

    const facets = await searchFacets(db);

    // The TYPE is the assertion that fails. `expect(total).toBe(3)` passes for
    // the string "3", which is the whole reason this bug survived three times.
    expect(typeof facets.sale.total).toBe('number');
    expect(typeof facets.sale.priceMin).toBe('number');
    expect(facets.sale.priceMin).toBe(23_000);
    expect(facets.sale.priceMax).toBe(50_000);
    expect(facets.sale.bedrooms).toEqual([3, 4]);
    expect(facets.sale.bathrooms).toEqual([2, 3]);
    expect(facets.sale.carSpaces).toEqual([1, 2]);
    expect(facets.sale.propertyTypes).toEqual(['house']);

    // An empty channel is empty, not absent — the UI needs to say "nothing to
    // rent right now" rather than render a tab that silently finds nothing.
    expect(facets.rent.total).toBe(0);
    expect(facets.rent.bedrooms).toEqual([]);
    expect(facets.rent.priceMin).toBeNull();
  });

  it('drops nulls and impossible room counts out of the aggregates', async () => {
    const db = fakeDb({
      suburbs: ['Pakenham', null],
      saleTotal: '2',
      // A null slips into array_agg when a property has no bedrooms recorded;
      // 23 is the kind of row the listing contract now refuses but older rows
      // may still hold.
      saleBedrooms: ['3', null, '0', '23'],
      saleBathrooms: [],
      saleCarSpaces: null,
      saleTypes: ['house', '', null],
      salePriceMin: null,
      salePriceMax: null,
      rentTotal: '0',
    });

    const facets = await searchFacets(db);
    expect(facets.sale.bedrooms).toEqual([3]);
    expect(facets.sale.propertyTypes).toEqual(['house']);
    expect(facets.suburbs).toEqual(['Pakenham']);
  });

  it('an empty database offers nothing rather than throwing', async () => {
    const facets = await searchFacets(fakeDb(undefined));
    expect(facets.sale.total).toBe(0);
    expect(facets.rent.total).toBe(0);
    expect(facets.suburbs).toEqual([]);
  });
});

describe('the price ladder', () => {
  it('stays strictly inside the range it was given', () => {
    // Every rung must exclude something at the bottom and leave something at
    // the top, or it is a control that does nothing.
    for (const [min, max] of [
      [23_000, 50_000],
      [250_000, 3_000_000],
      [180, 1_400],
      [1, 9],
    ] as [number, number][]) {
      const rungs = priceLadder(min, max);
      expect(rungs.length).toBeGreaterThan(0);
      for (const rung of rungs) {
        expect(rung).toBeGreaterThan(min);
        expect(rung).toBeLessThan(max);
      }
    }
  });

  it('is ascending and has no duplicates', () => {
    const rungs = priceLadder(23_000, 900_000);
    expect([...rungs].sort((a, b) => a - b)).toEqual(rungs);
    expect(new Set(rungs).size).toBe(rungs.length);
  });

  it('rounds to figures a person would type', () => {
    // Not $23,478 / $31,203 — buyers think in round numbers, and a ladder that
    // does not is a machine talking.
    for (const rung of priceLadder(23_000, 900_000)) {
      expect(rung % 1000).toBe(0);
    }
  });

  it('gives up rather than inventing a ladder it cannot build', () => {
    expect(priceLadder(null, null)).toEqual([]);
    expect(priceLadder(500_000, null)).toEqual([]);
    // One listing: min and max are the same figure, so there is no rung that
    // both excludes and includes something.
    expect(priceLadder(500_000, 500_000)).toEqual([]);
    expect(priceLadder(900_000, 100_000)).toEqual([]);
  });

  it('still offers something when the whole range is narrower than one step', () => {
    const rungs = priceLadder(500_000, 500_010);
    expect(rungs.length).toBe(1);
    expect(rungs[0]).toBeGreaterThan(500_000);
    expect(rungs[0]).toBeLessThan(500_010);
  });
});
