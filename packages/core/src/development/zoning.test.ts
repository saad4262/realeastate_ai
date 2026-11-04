import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import { adviceWords, DEVELOPMENT_QUESTIONS, NOT_A_PERMISSION } from './sources';
import { asOfText, landAndZoning, landAndZoningToolResult, nswZoneUrl, parseNswZones, parseVicZones, vicZoneUrl, zoneLabel, zoningAt, type ZoneFetch } from './zoning';

// The shapes the two services sent on 2026-11-04 (Pakenham VIC; Sydney CBD NSW), trimmed to what is read.
const VIC = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'plan_zone.44311', geometry: null, properties: { scheme_code: 'ZN', lga: 'CARDINIA', zone_code: 'ACZ1', zone_description: 'ACTIVITY CENTRE ZONE - SCHEDULE 1' } }], totalFeatures: 1 };
const NSW = { displayFieldName: 'EPI_NAME', features: [{ attributes: { EPI_NAME: 'Sydney Local Environmental Plan 2012', LGA_NAME: 'SYDNEY', SYM_CODE: 'SP5', LAY_CLASS: 'Metropolitan Centre' } }] };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noDb = {} as Db;
const PAKENHAM = { lat: -38.075, lng: 145.487 };

describe('Development: what the states send, read strictly (ADR 0080, C9 decision 4)', () => {
  it('Vicmap: the zone code and name, made readable, and the council', () => {
    expect(parseVicZones(VIC)).toEqual([{ code: 'ACZ1', name: 'Activity Centre Zone - Schedule 1', council: 'Cardinia', plan: null }]);
  });
  it('NSW: the zone code, its land use name, the council and the plan', () => {
    expect(parseNswZones(NSW)).toEqual([{ code: 'SP5', name: 'Metropolitan Centre', council: 'Sydney', plan: 'Sydney Local Environmental Plan 2012' }]);
  });
  it('an unknown shape, markup or an odd code shows nothing rather than something wrong', () => {
    expect(parseVicZones({ features: [] })).toBeNull();
    expect(parseVicZones({ type: 'FeatureCollection', features: [{ properties: { zone_code: 'GRZ1', zone_description: '<b>x</b>' } }] })).toBeNull();
    expect(parseVicZones({ type: 'FeatureCollection', features: [{ properties: { zone_code: 'GRZ 1; drop', zone_description: 'General' } }] })).toBeNull();
    expect(parseNswZones({ error: { code: 400 } })).toBeNull();
    expect(parseNswZones({ features: [{ attributes: { SYM_CODE: 'R2' } }] })).toBeNull();
  });
  it('no feature under the point is an empty list (not "unavailable"); one code twice is one zone', () => {
    expect(parseVicZones({ type: 'FeatureCollection', features: [] })).toEqual([]);
    expect(parseNswZones({ features: [NSW.features[0], NSW.features[0]] })).toHaveLength(1);
  });
  it('the addresses are the two fixed hosts; only the point varies, and a point outside Australia asks nothing', () => {
    expect(new URL(vicZoneUrl(-38.075, 145.487)!).host).toBe('opendata.maps.vic.gov.au');
    expect(new URL(vicZoneUrl(-38.075, 145.487)!).searchParams.get('cql_filter')).toBe('INTERSECTS(geom,SRID=4326;POINT(145.487000 -38.075000))');
    expect(new URL(nswZoneUrl(-33.8688, 151.2093)!).host).toBe('mapprod3.environment.nsw.gov.au');
    expect(vicZoneUrl(51.5, -0.12)).toBeNull();
    expect(nswZoneUrl(Number.NaN, 151)).toBeNull();
  });
});

describe('Development: the lookup by state (decisions 4, 7)', () => {
  const now = new Date('2026-11-04T03:00:00Z');
  it('VIC asks Vicmap once and says when it was checked', async () => {
    const f = vi.fn<ZoneFetch>(async () => json(VIC));
    const z = await zoningAt(noDb, 'VIC', PAKENHAM, { fetch: f, now });
    expect(f).toHaveBeenCalledTimes(1);
    expect(z).toMatchObject({ status: 'found', zones: [{ code: 'ACZ1' }], asOf: '2026-11-04', asOfKind: 'checked', source: { licence: 'CC BY 4.0' } });
  });
  it('a failed, slow or odd answer is "unavailable" — never a zone, never "none here"', async () => {
    expect((await zoningAt(noDb, 'VIC', PAKENHAM, { fetch: async () => json({}, 500) })).status).toBe('unavailable');
    expect((await zoningAt(noDb, 'NSW', PAKENHAM, { fetch: async () => { throw new Error('timeout'); } })).status).toBe('unavailable');
    expect((await zoningAt(noDb, 'NSW', PAKENHAM, { fetch: async () => json({ error: {} }) })).status).toBe('unavailable');
    expect((await zoningAt(noDb, 'VIC', PAKENHAM, { fetch: async () => json({ type: 'FeatureCollection', features: [] }), now })).status).toBe('none_here');
  });
  it('WA, QLD, TAS, ACT and NT ask nothing: "not verified", with the official map where we checked one', async () => {
    const f = vi.fn<ZoneFetch>();
    const wa = await zoningAt(noDb, 'WA', PAKENHAM, { fetch: f });
    expect(wa).toMatchObject({ status: 'not_verified', map: { label: 'PlanWA' } });
    expect(wa.status === 'not_verified' && wa.why).toMatch(/non-commercial/);
    for (const s of ['QLD', 'TAS', 'ACT', 'NT', 'XX']) expect((await zoningAt(noDb, s, PAKENHAM, { fetch: f })).status).toBe('not_verified');
    expect(f).not.toHaveBeenCalled();
  });
  it('no map point from the geocoder: no lookup at all', async () => {
    const f = vi.fn<ZoneFetch>();
    expect(await zoningAt(noDb, 'VIC', null, { fetch: f })).toEqual({ status: 'no_point' });
    expect(f).not.toHaveBeenCalled();
  });
  it('SA reads planning_zone (one query) and gives the file’s date; an empty table is "unavailable"', async () => {
    let calls = 0;
    const db = (rows: unknown[]) => ({ execute: async () => (calls++, rows) }) as unknown as Db;
    const sa = await zoningAt(db([{ published: '2026-08-21', zones: [{ code: 'GN', name: 'General Neighbourhood' }] }]), 'SA', { lat: -34.88, lng: 138.59 });
    expect(sa).toMatchObject({ status: 'found', zones: [{ code: 'GN', name: 'General Neighbourhood', plan: 'Planning and Design Code' }], asOf: '2026-08-21', asOfKind: 'data_dated' });
    expect(calls).toBe(1);
    expect((await zoningAt(db([{ published: '2026-08-21', zones: null }]), 'SA', { lat: -34.88, lng: 138.59 })).status).toBe('none_here');
    expect((await zoningAt(db([{ published: null, zones: null }]), 'SA', { lat: -34.88, lng: 138.59 })).status).toBe('unavailable');
  });
});

describe('Development: facts and questions, never advice (decision 6)', () => {
  const subject = { propertyId: 'p', state: 'VIC', at: PAKENHAM, landAreaSqm: 612 };
  const found = { status: 'found' as const, zones: [{ code: 'GRZ1', name: 'General Residential Zone - Schedule 1', council: 'Cardinia', plan: null }], source: { name: 'Vicmap Planning', licence: 'CC BY 4.0', url: 'https://x' }, asOf: '2026-11-04', asOfKind: 'checked' as const };

  it('the panel: the zone, the ad’s land size, the overlay map, the fixed questions and "not a permission"', () => {
    const p = landAndZoning(subject, found);
    expect(p).toMatchObject({ state: 'VIC', landAreaSqm: 612, questions: DEVELOPMENT_QUESTIONS, notAPermission: NOT_A_PERMISSION });
    expect(p.overlays?.label).toMatch(/VicPlan/);
    expect(zoneLabel(found.zones[0]!)).toBe('General Residential Zone - Schedule 1 (GRZ1)');
    expect(asOfText(found)).toBe('checked 4 Nov 2026');
    expect(asOfText({ asOf: '2026-08-21', asOfKind: 'data_dated' })).toBe('data dated 21 Aug 2026');
  });
  it('the guide’s result carries the records and forbids the advice', () => {
    const r = landAndZoningToolResult('14 Example Road, Officer', '/property/p#land', landAndZoning(subject, found));
    expect(r.zoning).toMatchObject({ found: true, zones: [{ zone: 'General Residential Zone - Schedule 1 (GRZ1)', council: 'Cardinia' }] });
    expect(r.landAreaSqm).toBe(612);
    expect(r.rules).toMatch(/Never say whether the land can be subdivided/);
    const na = landAndZoningToolResult('x', '/p', landAndZoning({ ...subject, state: 'WA' }, { status: 'not_verified', why: 'non-commercial', map: null }));
    expect(na.zoning).toMatchObject({ found: false, note: 'non-commercial' });
  });
  it('our own words never trip the advice check; the advice does', () => {
    for (const ours of [NOT_A_PERMISSION, ...DEVELOPMENT_QUESTIONS, 'Whether it can be subdivided depends on the minimum lot size.']) expect(adviceWords(ours), ours).toEqual([]);
    for (const bad of ['Yes, it can be subdivided.', 'You could subdivide it.', 'It suits a duplex.', 'There is room for 2 townhouses.', '612 m² is enough for two lots.', 'It has real development potential.', 'Worth $1.2m once split.']) expect(adviceWords(bad).length, bad).toBeGreaterThan(0);
  });
});
