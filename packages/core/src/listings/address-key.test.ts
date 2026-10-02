import { describe, expect, it } from 'vitest';
import type { DbOrTx } from '@repo/db';
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
  function fake(candidates: unknown[]) {
    const writes: string[] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'set', 'values']) chain[m] = () => chain;
    chain.execute = () => Promise.resolve([]);
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
    return { db: chain as unknown as DbOrTx, writes };
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
});
