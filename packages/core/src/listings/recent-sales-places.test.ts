import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { Db } from '@repo/db';
import { recentSales } from './recent-sales';

function proxy() {
  const seen: string[] = [];
  const db = drizzle(async (text: string, params: unknown[]) => {
    seen.push(`${text} ${JSON.stringify(params)}`);
    return { rows: [] };
  }) as unknown as Db;
  return { db, sql: () => seen.join('\n') };
}

/** ADR 0099: /sold over several suburbs, the same union /search draws. */
describe('recentSales with several places', () => {
  it('matches sales in ANY of the places', async () => {
    const { db, sql } = proxy();
    await recentSales(db, { places: [{ suburb: 'Pakenham', state: 'VIC' }, { suburb: 'Berwick', state: 'VIC', postcode: '3806' }] });
    const text = sql();
    expect(text).toMatch(/upper\(\$\d+\)\) or \(lower\("property"\."suburb"\) = lower\(\$\d+\)/);
    expect(text).toContain('"Pakenham"');
    expect(text).toContain('"Berwick"');
    expect(text).toContain('"3806"');
  });

  it('draws a circle around each place that has a centre', async () => {
    const { db, sql } = proxy();
    await recentSales(db, {
      places: [
        { suburb: 'Pakenham', near: { lat: -38.08, lng: 145.48, radiusKm: 10 } },
        { suburb: 'Berwick', near: { lat: -38.03, lng: 145.35, radiusKm: 10 } },
      ],
    });
    expect(sql().match(/ST_DWithin/g)?.length).toBe(2);
  });

  it('keeps a single suburb exactly as before', async () => {
    const { db, sql } = proxy();
    await recentSales(db, { suburb: 'Pakenham', state: 'VIC' });
    expect(sql()).not.toMatch(/\) or \(/);
    expect(sql()).not.toContain('ST_DWithin');
  });

  it('never searches more than ten places', async () => {
    const { db, sql } = proxy();
    await recentSales(db, { places: Array.from({ length: 14 }, (_, i) => ({ suburb: `Place${i}` })) });
    expect(sql()).toContain('"Place9"');
    expect(sql()).not.toContain('"Place10"');
  });
});

/** The Sold tab's Filters, as on /search (realestate.com.au parity brief). */
describe('recentSales filters', () => {
  it('applies beds, baths, cars, several types and a sold-price range', async () => {
    const { db, sql } = proxy();
    await recentSales(db, {
      bedrooms: 3,
      bathrooms: 2,
      carSpaces: 1,
      propertyTypes: ['House', 'townhouse'],
      priceFrom: 500000,
      priceTo: 900000,
    });
    const text = sql();
    expect(text).toMatch(/"bedrooms"\) >= \$\d+/);
    expect(text).toMatch(/"bathrooms"\) >= \$\d+/);
    expect(text).toMatch(/"car_spaces"\) >= \$\d+/);
    expect(text).toMatch(/"property_type"\), ''\)\) in \(\$\d+, \$\d+\)/);
    expect(text).toMatch(/"sold_price" >= \$\d+ and "listing"\."sold_price" <= \$\d+/);
    expect(text).toContain('["sold",3,"2",1,"house","townhouse","500000","900000",');
  });

  it('adds nothing when no filter is set', async () => {
    const { db, sql } = proxy();
    await recentSales(db, { suburb: 'Pakenham' });
    expect(sql()).not.toMatch(/"(bathrooms|car_spaces)"\) >=/);
    expect(sql()).not.toMatch(/"sold_price" [<>]=/);
    expect(sql()).not.toMatch(/''\)\) in \(/);
  });
});
