import { describe, expect, it } from 'vitest';
import { toRuntimeQuery } from './run-schedule';

const CENTRES: Record<string, { latitude: number; longitude: number }> = {
  'Pakenham, VIC, Australia': { latitude: -38.08, longitude: 145.48 },
  'Berwick, VIC, Australia': { latitude: -38.03, longitude: 145.35 },
};
const resolve = async (q: string) => {
  if (q.startsWith('Broken')) throw new Error('geocoder down');
  return (CENTRES[q] ?? null) as never;
};

/** ADR 0099: an alert over several suburbs draws a circle around each. */
describe('toRuntimeQuery with several places', () => {
  it('gives every place its own centre at the saved radius', async () => {
    const q = await toRuntimeQuery(
      { suburb: 'Pakenham', state: 'VIC', places: [{ suburb: 'Berwick', state: 'VIC' }], radiusKm: 10 },
      resolve,
    );
    expect(q.near).toEqual({ lat: -38.08, lng: 145.48, radiusKm: 10 });
    expect(q.places).toEqual([
      { suburb: 'Berwick', state: 'VIC', near: { lat: -38.03, lng: 145.35, radiusKm: 10 } },
    ]);
  });

  it('gives each place its own distance when it carries one', async () => {
    const q = await toRuntimeQuery(
      { places: [{ suburb: 'Pakenham', state: 'VIC', km: 10 }, { suburb: 'Berwick', state: 'VIC', km: 20 }, { suburb: 'Nowhere' }] },
      resolve,
    );
    expect(q.places).toEqual([
      { suburb: 'Pakenham', state: 'VIC', near: { lat: -38.08, lng: 145.48, radiusKm: 10 } },
      { suburb: 'Berwick', state: 'VIC', near: { lat: -38.03, lng: 145.35, radiusKm: 20 } },
      { suburb: 'Nowhere' },
    ]);
  });

  it('keeps the name match of a place the geocoder cannot find or fails on', async () => {
    const q = await toRuntimeQuery(
      { places: [{ suburb: 'Nowhere' }, { suburb: 'Broken' }], radiusKm: 5 },
      resolve,
    );
    expect(q.places).toEqual([{ suburb: 'Nowhere' }, { suburb: 'Broken' }]);
  });

  it('searches the places by name, with no lookups, when there is no radius', async () => {
    let calls = 0;
    const q = await toRuntimeQuery({ places: [{ suburb: 'Berwick' }, { suburb: 'Officer' }] }, async () => {
      calls += 1;
      return null;
    });
    expect(calls).toBe(0);
    expect(q.places).toEqual([{ suburb: 'Berwick' }, { suburb: 'Officer' }]);
  });
});

describe('toRuntimeQuery keeps smart search keywords', () => {
  it('passes mustMention through to the search', async () => {
    const q = await toRuntimeQuery({ suburb: 'Pakenham', state: 'VIC', mustMention: ['pool'] }, resolve);
    expect(q.mustMention).toEqual(['pool']);
  });
});
