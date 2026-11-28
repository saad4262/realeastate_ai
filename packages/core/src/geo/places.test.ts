import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { GeoProvider, ResolvedPlace } from './place-schema';
import { geocodeAddress, resolvePlace, sameAddress } from './places';

const bondi: ResolvedPlace = {
  placeId: 'ChIJ-wbsR5utEmsR7MvvTmc-DEU',
  formatted: '12 Campbell Parade, Bondi Beach NSW 2026, Australia',
  unit: null,
  streetNumber: '12',
  street: 'Campbell Parade',
  suburb: 'Bondi Beach',
  state: 'NSW',
  postcode: '2026',
  latitude: -33.894492,
  longitude: 151.273026,
  kind: 'address',
};

/**
 * Drizzle stand-in that serves queued SELECTs and records what was inserted.
 *
 * The insert is the interesting half here: the bug this file exists for was a
 * cache that wrote fewer columns than it was given, so what reaches `values()`
 * is the thing under test.
 */
function fakeDb(rows: unknown[][] = []) {
  let i = 0;
  const inserted: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'selectDistinct', 'from', 'innerJoin', 'where', 'insert',
                   'update', 'set', 'onConflictDoUpdate']) {
    chain[m] = () => chain;
  }
  chain.values = (v: Record<string, unknown>) => {
    inserted.push(v);
    return chain;
  };
  chain.limit = () => Promise.resolve(rows[i++] ?? []);
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(rows[i++] ?? []).then(res);
  return { db: chain as unknown as Db, inserted };
}

/** A provider that counts its calls, so a cache hit is provable. */
function fakeProvider(place: ResolvedPlace | null): GeoProvider & { calls: number } {
  const p = {
    name: 'fake',
    calls: 0,
    async suggest() {
      return [];
    },
    async resolve() {
      p.calls += 1;
      return place;
    },
    async reverse() {
      p.calls += 1;
      return place;
    },
  };
  return p;
}

/** resolvePlace only reaches the provider when the key is present. */
function withKey<T>(run: () => Promise<T>): Promise<T> {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  return run().finally(() => {
    delete process.env.GOOGLE_MAPS_API_KEY;
  });
}

describe('place cache', () => {
  it('stores the street parts, not only the suburb', async () => {
    const { db, inserted } = fakeDb([[] /* cache miss */]);
    const provider = fakeProvider(bondi);

    await withKey(() => resolvePlace(db, bondi.placeId as string, { provider }));

    // The whole point: a cache row that cannot answer with a street number is
    // a cache row that blanks the agent's form the second time around.
    expect(inserted[0]).toMatchObject({
      streetNumber: '12',
      street: 'Campbell Parade',
      suburb: 'Bondi Beach',
      formatted: bondi.formatted,
    });
  });

  it('answers a second lookup from the cache, with the street intact', async () => {
    const cached = [
      {
        placeId: bondi.placeId,
        formatted: bondi.formatted,
        unit: null,
        streetNumber: '12',
        street: 'Campbell Parade',
        suburb: 'Bondi Beach',
        state: 'NSW',
        postcode: '2026',
        latitude: '-33.894492',
        longitude: '151.273026',
        kind: 'address',
      },
    ];
    const { db } = fakeDb([cached]);
    const provider = fakeProvider(bondi);

    const place = await withKey(() => resolvePlace(db, bondi.placeId as string, { provider }));

    expect(provider.calls).toBe(0);
    expect(place?.streetNumber).toBe('12');
    expect(place?.street).toBe('Campbell Parade');
    expect(place?.suburb).toBe('Bondi Beach');
  });

  it('re-asks the provider for an address row cached without a street', async () => {
    // Rows written before the cache carried street parts. Answering from one
    // hands the form nulls and it clears the fields on screen.
    const stale = [
      {
        placeId: bondi.placeId,
        formatted: bondi.formatted,
        unit: null,
        streetNumber: null,
        street: null,
        suburb: 'Bondi Beach',
        state: 'NSW',
        postcode: '2026',
        latitude: '-33.894492',
        longitude: '151.273026',
        kind: 'address',
      },
    ];
    const { db, inserted } = fakeDb([stale]);
    const provider = fakeProvider(bondi);

    const place = await withKey(() => resolvePlace(db, bondi.placeId as string, { provider }));

    expect(provider.calls).toBe(1);
    expect(place?.street).toBe('Campbell Parade');
    // And the stale row is replaced, so it costs one lookup once.
    expect(inserted[0]).toMatchObject({ street: 'Campbell Parade' });
  });

  it('keeps a suburb row cached even though it has no street', async () => {
    const suburbRow = [
      {
        placeId: 'ChIJxuv0xoYb1moRSOcMIXvwBAU',
        formatted: 'Pakenham VIC 3810, Australia',
        unit: null,
        streetNumber: null,
        street: null,
        suburb: 'Pakenham',
        state: 'VIC',
        postcode: '3810',
        latitude: '-38.079103',
        longitude: '145.484215',
        kind: 'locality',
      },
    ];
    const { db } = fakeDb([suburbRow]);
    const provider = fakeProvider(null);

    const place = await withKey(() => resolvePlace(db, 'ChIJxuv0xoYb1moRSOcMIXvwBAU', { provider }));

    expect(provider.calls).toBe(0);
    expect(place?.suburb).toBe('Pakenham');
  });
});

describe('geocodeAddress', () => {
  it('returns the pinned line and the kind alongside the coordinates', async () => {
    const { db } = fakeDb([[]]);
    const provider = fakeProvider(bondi);

    const hit = await withKey(() =>
      geocodeAddress(
        db,
        { streetNumber: '12', street: 'Campbell Parade', suburb: 'Bondi Beach', state: 'NSW', postcode: '2026' },
        { provider },
      ),
    );

    expect(hit).toMatchObject({
      latitude: -33.894492,
      longitude: 151.273026,
      formatted: '12 Campbell Parade, Bondi Beach NSW 2026, Australia',
      // The caller needs this to refuse a street address that resolved to a
      // state centroid — a pin 400 km from the property.
      kind: 'address',
    });
  });
});

describe('sameAddress: Google’s nearest guess is not this address', () => {
  const asked = { streetNumber: '14', street: 'Henry St', suburb: 'Pakenham', state: 'VIC', postcode: '3810' };
  const found = (p: Partial<ResolvedPlace>) => ({ streetNumber: '14', street: 'Henry Street', suburb: 'Pakenham', postcode: '3810', ...p });

  it('the same address, however it is written', () => {
    expect(sameAddress(asked, found({}))).toBe(true);
    expect(sameAddress({ ...asked, suburb: 'pakenham.' }, found({}))).toBe(true);
    expect(sameAddress({ unit: '2', streetNumber: '6E', street: 'Main St', suburb: 'Officer', state: 'VIC', postcode: '3809' }, found({ streetNumber: '6e', street: 'Main Street', suburb: 'Officer', postcode: '3809' }))).toBe(true);
    expect(sameAddress({ streetNumber: '32/6E', street: 'Main St', suburb: 'Officer', state: 'VIC', postcode: '3809' }, found({ streetNumber: '6E', street: 'Main Street', suburb: 'Officer', postcode: '3809' }))).toBe(true);
    // Google's suburb boundary differs, the postcode agrees.
    expect(sameAddress(asked, found({ suburb: 'Pakenham Upper' }))).toBe(true);
    // Vacant land with no number.
    expect(sameAddress({ streetNumber: '', street: 'Lot 12 Smith Rd', suburb: 'Clyde', state: 'VIC', postcode: '3978' }, found({ streetNumber: null, street: 'Smith Road', suburb: 'Clyde', postcode: '3978' }))).toBe(true);
  });

  it('refuses the four answers a dry run accepted on 2026-11-25', () => {
    expect(sameAddress(asked, found({ streetNumber: '214' }))).toBe(false);
    expect(sameAddress({ unit: '2', streetNumber: '6E', street: 'Main Street', suburb: 'Officer', state: 'VIC', postcode: '3809' }, found({ streetNumber: '34', street: 'Station Street', suburb: 'Officer', postcode: '3809' }))).toBe(false);
    expect(sameAddress({ streetNumber: '3', street: 'Golden Wattle Court', suburb: 'Berwick', state: 'VIC', postcode: '3806' }, found({ streetNumber: '43', street: 'Golden Wattle Court', suburb: 'Cranbourne', postcode: '3977' }))).toBe(false);
    expect(sameAddress({ streetNumber: '22', street: 'Station Street', suburb: 'Pakenham', state: 'VIC', postcode: '3810' }, found({ streetNumber: '522', street: 'Station Street' }))).toBe(false);
  });

  it('refuses another street, another suburb and postcode, or no street at all', () => {
    expect(sameAddress(asked, found({ street: 'Henry Road' }))).toBe(false);
    expect(sameAddress(asked, found({ suburb: 'Officer', postcode: '3809' }))).toBe(false);
    expect(sameAddress(asked, found({ street: null }))).toBe(false);
    // A number was given: "Lot"-style suffix matching does not apply.
    expect(sameAddress({ ...asked, street: 'Old Henry St' }, found({}))).toBe(false);
  });
});
