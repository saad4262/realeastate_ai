import { describe, expect, it } from 'vitest';
import type { DbOrTx } from '@repo/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { addressKey } from './address-key';
import { upsertProperty } from './property-resolver';

const base = { suburb: 'Pakenham', state: 'VIC', postcode: '3810' };

describe('addressKey folds two spellings of one dwelling together', () => {
  it.each([
    ['street type abbreviated', { unit: '32', streetNumber: '6E', street: 'Henry St' }],
    ['case and spacing', { unit: '32', streetNumber: '6 e', street: '  henry   STREET ' }],
    ['unit written with a prefix', { unit: 'Unit 32', streetNumber: '6E', street: 'Henry Street' }],
    ['unit written into the number', { unit: '', streetNumber: '32/6E', street: 'Henry Street' }],
    ['stray punctuation', { unit: '32', streetNumber: '6E', street: 'Henry St.' }],
  ])('%s', (_label, parts) => {
    const original = { unit: '32', streetNumber: '6E', street: 'Henry Street', ...base };
    expect(addressKey({ ...base, ...parts })).toBe(addressKey(original));
  });

  it('matches the suburb regardless of case', () => {
    expect(addressKey({ streetNumber: '10', street: 'Main Rd', ...base, suburb: 'PAKENHAM' })).toBe(
      addressKey({ streetNumber: '10', street: 'Main Road', ...base }),
    );
  });
});

describe('addressKey keeps different dwellings apart', () => {
  const house = { unit: '32', streetNumber: '6E', street: 'Henry Street', ...base };

  it.each([
    ['another unit in the building', { unit: '31' }],
    ['the building itself, no unit', { unit: '' }],
    ['another street number', { streetNumber: '6F' }],
    ['another street type', { street: 'Henry Road' }],
    ['the same street in another suburb', { suburb: 'Officer' }],
    ['another postcode', { postcode: '3809' }],
  ])('%s', (_label, change) => {
    expect(addressKey({ ...house, ...change })).not.toBe(addressKey(house));
  });
});

/**
 * The requirement itself: a second agency typing the address its own way
 * lands on the property the first agency's sale is recorded against, so the
 * new listing carries that history rather than starting a second house.
 */
describe('upsertProperty reuses the property a re-listing agency describes differently', () => {
  function fake(candidates: unknown[], opts: { usedByAnotherAgency?: boolean } = {}) {
    const writes: string[] = [];
    const sets: Record<string, unknown>[] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'values']) chain[m] = () => chain;
    chain.set = (v: Record<string, unknown>) => {
      sets.push(v);
      return chain;
    };
    // The advisory lock, then (ADR 0075) "is this address used by another agency?".
    chain.execute = () => Promise.resolve([{ used: Boolean(opts.usedByAnotherAgency) }]);
    chain.update = () => {
      writes.push('update');
      return chain;
    };
    chain.insert = () => {
      writes.push('insert');
      return chain;
    };
    let reads = 0;
    chain.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(reads++ === 0 ? candidates : []).then(res);
    chain.returning = () => Promise.resolve([{ id: 'p-new' }]);
    return { db: chain as unknown as DbOrTx, writes, sets };
  }

  const soldBefore = {
    id: 'p-sold-2025',
    latitude: '-38.07',
    unit: '32',
    streetNumber: '6E',
    street: 'Henry Street',
    ...base,
  };

  it('joins the existing property instead of inserting a second one', async () => {
    const { db, writes } = fake([soldBefore]);
    const id = await upsertProperty(
      db,
      { unit: 'Unit 32', streetNumber: '6e', street: 'Henry St', suburb: 'pakenham', state: 'VIC', postcode: '3810' },
      null,
    );
    expect(id).toBe('p-sold-2025');
    expect(writes).toEqual(['update']);
  });

  it('still creates a new property for a different unit in the same building', async () => {
    const { db, writes } = fake([soldBefore]);
    const id = await upsertProperty(
      db,
      { unit: '31', streetNumber: '6E', street: 'Henry Street', ...base, state: 'VIC' },
      null,
    );
    expect(id).toBe('p-new');
    expect(writes).toEqual(['insert']);
  });

  /**
   * The bug this guards: a re-listing agency that leaves bedrooms blank used
   * to write NULL over the bedrooms the first agency recorded — erasing them
   * for every listing at the address.
   */
  it('leaves facts the new ad does not state untouched', async () => {
    const { db, sets } = fake([soldBefore]);
    await upsertProperty(
      db,
      { unit: '32', streetNumber: '6E', street: 'Henry Street', ...base, state: 'VIC', bedrooms: 4 },
      null,
    );
    const written = sets[0] ?? {};
    expect(written).toHaveProperty('bedrooms');
    for (const blank of ['bathrooms', 'carSpaces', 'landAreaSqm', 'buildingAreaSqm', 'yearBuilt', 'propertyType']) {
      expect(written).not.toHaveProperty(blank);
    }
  });

  /** ADR 0075: the address is shared; an ad's facts live on its listing and never rewrite the address. */
  it('never overwrites a fact the address has: it only fills an empty one (coalesce), and never writes a blank', async () => {
    const { db, sets } = fake([soldBefore]);
    await upsertProperty(db, { unit: '32', streetNumber: '6E', street: 'Henry Street', ...base, state: 'VIC', bedrooms: 3 }, null, { agencyId: 'agency-b' });
    const written = sets[0] ?? {};
    expect(written.bedrooms).not.toBe(3);
    const q = new PgDialect().sqlToQuery(written.bedrooms as SQL);
    expect(q.sql).toMatch(/^coalesce\("property"\."bedrooms", \$1\)$/);
    expect(q.params).toEqual([3]);
    expect(Object.values(written)).not.toContain(null);
  });

  const pin = { latitude: '-38.000001', longitude: '145.000001', placeId: null, formattedAddress: null, geocodedAt: new Date(), geocodeSource: 'manual' as const };
  const dragged = { unit: '32', streetNumber: '6E', street: 'Henry Street', ...base, state: 'VIC' as const, latitude: -38.000001, longitude: 145.000001 };

  it('does not move the pin of an address another agency uses — even a pin the agent dragged', async () => {
    const { db, sets } = fake([soldBefore], { usedByAnotherAgency: true });
    await upsertProperty(db, dragged, pin, { agencyId: 'agency-b' });
    expect(sets[0]).not.toHaveProperty('latitude');
  });

  it('moves it when nobody else is at the address, and fills an address that has no pin', async () => {
    const own = fake([soldBefore], { usedByAnotherAgency: false });
    await upsertProperty(own.db, dragged, pin, { agencyId: 'agency-a' });
    expect(own.sets[0]).toMatchObject({ latitude: '-38.000001' });
    const empty = fake([{ ...soldBefore, latitude: null }], { usedByAnotherAgency: true });
    await upsertProperty(empty.db, { unit: '32', streetNumber: '6E', street: 'Henry Street', ...base, state: 'VIC' }, pin, { agencyId: 'agency-b' });
    expect(empty.sets[0]).toMatchObject({ latitude: '-38.000001' });
  });

  it('without the saving agency, a carried pin never moves an existing one', async () => {
    const { db, sets } = fake([soldBefore], { usedByAnotherAgency: false });
    await upsertProperty(db, dragged, pin);
    expect(sets[0]).not.toHaveProperty('latitude');
  });
});
