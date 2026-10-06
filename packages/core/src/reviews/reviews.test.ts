import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { agencyGooglePlace } from '@repo/db/schema';
import { googlePlacesFromEnv, isPlaceId, parseDetails, type PlacesClient } from './google-places';
import { ReviewError, searchGooglePlaces, setAgencyGooglePlace } from './reviews';

/** ADR 0028 step 1, under Google's Places terms: store the place id only, attribute everything. */

const PLACE = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('what we keep from Google', () => {
  it('the table can hold a place id and who picked it — no name, address, rating or review', () => {
    const cols = getTableConfig(agencyGooglePlace).columns.map((c) => c.name).sort();
    expect(cols).toEqual(['agency_id', 'created_at', 'id', 'picked_at', 'picked_by', 'place_id', 'updated_at']);
  });
});

describe('the Places client', () => {
  it('sends the key only as a header, with a field mask, and never returns it', async () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'secret-key-123');
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ places: [{ id: PLACE, displayName: { text: 'Smoke Realty' }, formattedAddress: '1 Main St, Pakenham VIC', rating: 4.6, userRatingCount: 88 }, { id: 'bad id!' }] }), { status: 200 });
    });
    const hits = await googlePlacesFromEnv()!.search('Smoke Realty Pakenham');
    expect(hits).toEqual([{ placeId: PLACE, name: 'Smoke Realty', address: '1 Main St, Pakenham VIC', rating: 4.6, ratingCount: 88 }]);
    expect(calls[0]!.url).not.toContain('secret-key-123');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['X-Goog-Api-Key']).toBe('secret-key-123');
    expect(h['X-Goog-FieldMask']).toMatch(/places\.id/);
    expect(JSON.stringify(hits)).not.toContain('secret');
  });

  it('details: reviews with their author attribution and links; a retired id is not_found; an outage is null', async () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'k');
    let answer: Response = new Response('{}');
    vi.stubGlobal('fetch', async () => answer);
    const c = googlePlacesFromEnv()!;
    answer = new Response(JSON.stringify({
      id: PLACE, displayName: { text: 'Smoke Realty' }, rating: 4.2, userRatingCount: 12, googleMapsUri: 'https://maps.google.com/?cid=1',
      reviews: [{ rating: 5, relativePublishTimeDescription: '2 weeks ago', text: { text: 'Great' }, authorAttribution: { displayName: 'Sam', uri: 'https://www.google.com/maps/contrib/1', photoUri: 'javascript:alert(1)' }, googleMapsUri: 'https://www.google.com/maps/reviews/1' }],
    }));
    const d = await c.details(PLACE);
    expect(d).toMatchObject({ rating: 4.2, ratingCount: 12, mapsUri: 'https://maps.google.com/?cid=1' });
    expect(d && d !== 'not_found' && d.reviews[0]).toEqual({ rating: 5, text: 'Great', when: '2 weeks ago', author: { name: 'Sam', uri: 'https://www.google.com/maps/contrib/1', photoUri: null }, mapsUri: 'https://www.google.com/maps/reviews/1' });
    answer = new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 });
    expect(await c.details(PLACE)).toBe('not_found');
    answer = new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 429 });
    expect(await c.details(PLACE)).toBeNull();
    expect(await c.details('../../etc')).toBe('not_found');
  });

  it('no key → no client (the screens say Google is not set up)', () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', '');
    expect(googlePlacesFromEnv()).toBeNull();
  });

  it('place ids are tokens, never paths', () => {
    expect(isPlaceId(PLACE)).toBe(true);
    for (const bad of ['', 'short', '../x/../../y', 'a b c d e f g h', 'x'.repeat(401), 42]) expect(isPlaceId(bad)).toBe(false);
    expect(parseDetails({})).toBeNull();
  });
});

describe('the picker', () => {
  const owner = { userId: 'o', agencyId: 'a', membershipRole: 'owner' as const };
  const agent = { userId: 'g', agencyId: 'a', membershipRole: 'agent' as const };
  const fake: PlacesClient = { search: async () => [], details: async () => 'not_found' };
  it('only an owner or admin may search or pick; one search a second', async () => {
    await expect(searchGooglePlaces(agent, 'Smoke Realty', { places: fake })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setAgencyGooglePlace({} as never, agent, PLACE, { places: fake })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(searchGooglePlaces(owner, 'Smoke Realty', { places: fake }, 10_000)).resolves.toEqual([]);
    await expect(searchGooglePlaces(owner, 'Smoke Realty', { places: fake }, 10_500)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(searchGooglePlaces(owner, 'ab', { places: fake }, 20_000)).rejects.toBeInstanceOf(ReviewError);
  });
  it('a place Google no longer has is refused before anything is written', async () => {
    const db = { insert: () => { throw new Error('wrote'); } } as never;
    await expect(setAgencyGooglePlace(db, owner, PLACE, { places: fake })).rejects.toMatchObject({ code: 'invalid' });
    await expect(setAgencyGooglePlace(db, owner, 'not a place', { places: fake })).rejects.toMatchObject({ code: 'invalid' });
  });
});
