import { and, eq, sql } from 'drizzle-orm';
import { listing, property, type DbOrTx } from '@repo/db';
import { adFacts, lastAdFact } from '../listings/facts';
import { DEVELOPMENT_QUESTIONS, NOT_A_PERMISSION, OVERLAY_MAP, ZONE_SOURCES, type ZoneState } from './sources';

/**
 * Property Development AI's lookup (ADR 0080, C9 decisions 4–7; mock docs/mocks/consumer-media-land.html#development).
 * A property's zone from its state's own data, by its map point: VIC and NSW asked live (a network call — callers
 * make it before any transaction, and the web keeps the answer 30 days per point), SA read from `planning_zone`.
 * What the state sends is checked against the shapes it publishes before a word of it is shown; anything else is
 * "unavailable", never a guess. Facts only: no model writes any of this, and nothing here says what may be built.
 */

export type Zone = { code: string; name: string; council: string | null; plan: string | null };
export type ZoneSourceLine = { name: string; licence: string; url: string };

export type ZoningAnswer =
  | { status: 'found'; zones: Zone[]; source: ZoneSourceLine; asOf: string; asOfKind: 'checked' | 'data_dated' }
  | { status: 'none_here'; source: ZoneSourceLine; asOf: string; asOfKind: 'checked' | 'data_dated' }
  | { status: 'not_verified'; why: string; map: { label: string; url: string } | null }
  | { status: 'no_point' }
  | { status: 'unavailable' };

export type ZoneFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

const TIMEOUT_MS = 8_000;
/** "GRZ1", "R2", "SP5", "E(BH)", "UC(MS)": letters and digits, then at most one bracketed qualifier. */
const CODE = /^[A-Za-z0-9]{1,8}(\([A-Za-z0-9]{1,6}\))?$/;
const SMALL_WORDS = new Set(['and', 'of', 'the', 'or', 'for', 'in', 'to']);

function isZoneState(s: string): s is ZoneState {
  return Object.hasOwn(ZONE_SOURCES, s);
}

/** A string the state sent, as plain text: trimmed, one space, no markup or control characters, within a length. */
function plain(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length < 1 || s.length > max || /[<>{}\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

/** "ACTIVITY CENTRE ZONE - SCHEDULE 1" → "Activity Centre Zone - Schedule 1"; a mixed-case string is left as sent. */
function readable(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .split(' ')
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.replace(/^[a-z]/, (c) => c.toUpperCase())))
    .join(' ');
}

function point(lat: number, lng: number): { lat: string; lng: string } | null {
  // Australia and its islands, generously: a point outside is not a property we hold.
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -44.5 || lat > -9 || lng < 112 || lng > 154.5) return null;
  return { lat: lat.toFixed(6), lng: lng.toFixed(6) };
}

/** Vicmap Planning's zone layer, the one feature under the point. Fixed host; only the point varies. */
export function vicZoneUrl(lat: number, lng: number): string | null {
  const p = point(lat, lng);
  if (!p) return null;
  const q = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'open-data-platform:plan_zone',
    outputFormat: 'application/json',
    propertyName: 'zone_code,zone_description,lga,scheme_code',
    cql_filter: `INTERSECTS(geom,SRID=4326;POINT(${p.lng} ${p.lat}))`,
    count: '5',
  });
  return `https://opendata.maps.vic.gov.au/geoserver/wfs?${q}`;
}

/** The NSW Planning Portal's Land Zoning layer (Principal Planning Layers, layer 19). */
export function nswZoneUrl(lat: number, lng: number): string | null {
  const p = point(lat, lng);
  if (!p) return null;
  const q = new URLSearchParams({
    geometry: `${p.lng},${p.lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'EPI_NAME,LGA_NAME,SYM_CODE,LAY_CLASS',
    returnGeometry: 'false',
    resultRecordCount: '5',
    f: 'json',
  });
  return `https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/ePlanning/Planning_Portal_Principal_Planning/MapServer/19/query?${q}`;
}

function dedupe(zones: Zone[]): Zone[] {
  const seen = new Set<string>();
  return zones.filter((z) => (seen.has(z.code) ? false : (seen.add(z.code), true))).slice(0, 3);
}

/** Vicmap's answer → zones, or null when it is not the shape Vicmap sends (then nothing is shown). Pure. */
export function parseVicZones(json: unknown): Zone[] | null {
  const features = (json as { type?: unknown; features?: unknown } | null)?.features;
  if ((json as { type?: unknown } | null)?.type !== 'FeatureCollection' || !Array.isArray(features)) return null;
  const out: Zone[] = [];
  for (const f of features) {
    const p = (f as { properties?: Record<string, unknown> } | null)?.properties ?? {};
    const code = plain(p.zone_code, 12);
    const name = plain(p.zone_description, 150);
    if (!code || !CODE.test(code) || !name) return null;
    const council = plain(p.lga, 80);
    out.push({ code, name: readable(name), council: council ? readable(council) : null, plan: null });
  }
  return dedupe(out);
}

/** The NSW Planning Portal's answer → zones, or null when it is not the shape the portal sends. Pure. */
export function parseNswZones(json: unknown): Zone[] | null {
  const doc = json as { error?: unknown; features?: unknown } | null;
  if (!doc || doc.error || !Array.isArray(doc.features)) return null;
  const out: Zone[] = [];
  for (const f of doc.features) {
    const a = (f as { attributes?: Record<string, unknown> } | null)?.attributes ?? {};
    const code = plain(a.SYM_CODE, 12);
    const name = plain(a.LAY_CLASS, 120);
    if (!code || !CODE.test(code) || !name) return null;
    const council = plain(a.LGA_NAME, 80);
    out.push({ code, name: readable(name), council: council ? readable(council) : null, plan: plain(a.EPI_NAME, 150) });
  }
  return dedupe(out);
}

async function askLive(url: string | null, parse: (json: unknown) => Zone[] | null, fetchImpl: ZoneFetch): Promise<Zone[] | null> {
  if (!url) return null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return parse(await res.json());
  } catch {
    return null;
  }
}

/** South Australia's zones under the point, from `planning_zone`, and the file's date. One read. */
async function askSaTable(db: DbOrTx, lat: number, lng: number): Promise<{ zones: Zone[]; publishedOn: string } | null> {
  const p = point(lat, lng);
  if (!p) return null;
  const at = sql`ST_SetSRID(ST_MakePoint(${Number(p.lng)}, ${Number(p.lat)}), 4326)`;
  const rows = (await db.execute<{ published: string | null; zones: { code: string; name: string }[] | null }>(sql`
    select (select max(published_on)::text from planning_zone where source = 'sa_pdcode') as published,
           (select json_agg(json_build_object('code', z.zone_code, 'name', z.zone_name))
              from (select zone_code, zone_name from planning_zone where source = 'sa_pdcode' and ST_Covers(geom, ${at}) limit 3) z) as zones`)) as unknown as { published: string | null; zones: { code: string; name: string }[] | null }[];
  const row = rows[0];
  if (!row?.published) return null; // not loaded: unavailable, never "no zone here"
  return { zones: dedupe((row.zones ?? []).map((z) => ({ code: z.code, name: z.name, council: null, plan: 'Planning and Design Code' }))), publishedOn: row.published };
}

/**
 * The zone at a point, as its state publishes it (decision 4). A state with no usable source says so and links its map;
 * no point from the geocoder (or the agent's own pin) means no lookup. `unavailable` when the state's service failed or
 * answered in a shape we do not know — callers must not keep that answer.
 */
export async function zoningAt(
  db: DbOrTx,
  state: string,
  at: { lat: number; lng: number } | null,
  deps: { fetch?: ZoneFetch; now?: Date } = {},
): Promise<ZoningAnswer> {
  if (!isZoneState(state)) return { status: 'not_verified', why: 'We have no zoning source for this address.', map: null };
  const src = ZONE_SOURCES[state];
  if (src.status === 'not_verified') return { status: 'not_verified', why: src.why, map: src.map };
  if (!at) return { status: 'no_point' };
  const source = { name: src.name, licence: src.licence, url: src.url };
  if (src.kind === 'sa_table') {
    const sa = await askSaTable(db, at.lat, at.lng);
    if (!sa) return { status: 'unavailable' };
    return sa.zones.length ? { status: 'found', zones: sa.zones, source, asOf: sa.publishedOn, asOfKind: 'data_dated' } : { status: 'none_here', source, asOf: sa.publishedOn, asOfKind: 'data_dated' };
  }
  const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
  const zones = src.kind === 'vic_wfs' ? await askLive(vicZoneUrl(at.lat, at.lng), parseVicZones, fetchImpl) : await askLive(nswZoneUrl(at.lat, at.lng), parseNswZones, fetchImpl);
  if (!zones) return { status: 'unavailable' };
  const asOf = (deps.now ?? new Date()).toISOString().slice(0, 10);
  return zones.length ? { status: 'found', zones, source, asOf, asOfKind: 'checked' } : { status: 'none_here', source, asOf, asOfKind: 'checked' };
}

export type ZoningSubject = { propertyId: string; state: string; at: { lat: number; lng: number } | null; landAreaSqm: number | null };

/**
 * What the panel is about: the property's state, its map point when the geocoder (or the agent's own pin) placed it,
 * and the land size the page beside it shows (ADR 0075) — this listing's ad, else the address's record; for an address
 * off the market, its newest ad's. The CALLER has shown the property is public (the listing page, /property/<id>, the
 * guide's readers). One read.
 */
export async function zoningSubject(db: DbOrTx, propertyId: string, listingId: string | null = null): Promise<ZoningSubject | null> {
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(propertyId) || (listingId !== null && !uuid.test(listingId))) return null;
  const fields = { state: property.state, lat: property.latitude, lng: property.longitude, source: property.geocodeSource };
  const [row] = listingId
    ? await db
        .select({ ...fields, land: adFacts.landAreaSqm })
        .from(property)
        .leftJoin(listing, and(eq(listing.id, listingId), eq(listing.propertyId, property.id)))
        .where(eq(property.id, propertyId))
        .limit(1)
    : await db
        .select({ ...fields, land: sql<string | null>`${lastAdFact('land_area_sqm', property.landAreaSqm)}` })
        .from(property)
        .where(eq(property.id, propertyId))
        .limit(1);
  if (!row) return null;
  const placed = row.source === 'google' || row.source === 'manual';
  const lat = row.lat === null ? NaN : Number(row.lat);
  const lng = row.lng === null ? NaN : Number(row.lng);
  const land = row.land === null ? null : Number(row.land);
  return {
    propertyId,
    state: row.state,
    at: placed && point(lat, lng) ? { lat, lng } : null,
    landAreaSqm: land !== null && Number.isFinite(land) && land > 0 ? land : null,
  };
}

export type LandAndZoning = {
  state: string;
  zoning: ZoningAnswer;
  landAreaSqm: number | null;
  overlays: { label: string; url: string } | null;
  questions: string[];
  notAPermission: string;
};

/** The panel (decision 6): the zone, the land size, where overlays are, the state's questions. Pure. */
export function landAndZoning(subject: ZoningSubject, zoning: ZoningAnswer): LandAndZoning {
  const state = subject.state;
  return {
    state,
    zoning,
    landAreaSqm: subject.landAreaSqm,
    overlays: isZoneState(state) ? (OVERLAY_MAP[state] ?? null) : null,
    questions: DEVELOPMENT_QUESTIONS,
    notAPermission: NOT_A_PERMISSION,
  };
}

/** "General Residential Zone - Schedule 1 (GRZ1)". Pure. */
export function zoneLabel(z: Zone): string {
  return z.name.includes(z.code) ? z.name : `${z.name} (${z.code})`;
}

const AS_OF = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "checked 4 Nov 2026" / "data dated 21 Aug 2026". Pure. */
export function asOfText(z: { asOf: string; asOfKind: 'checked' | 'data_dated' }): string {
  const d = new Date(`${z.asOf}T00:00:00Z`);
  const when = Number.isNaN(d.getTime()) ? z.asOf : AS_OF.format(d);
  return `${z.asOfKind === 'checked' ? 'checked' : 'data dated'} ${when}`;
}

/** What the guide reads (decision 12): the panel's records and the rules for using them. Pure. */
export function landAndZoningToolResult(address: string, page: string, panel: LandAndZoning) {
  const z = panel.zoning;
  return {
    address,
    state: panel.state,
    zoning:
      z.status === 'found'
        ? { found: true, zones: z.zones.map((x) => ({ zone: zoneLabel(x), council: x.council, plan: x.plan })), source: `${z.source.name}, ${z.source.licence}, ${asOfText(z)}` }
        : z.status === 'none_here'
          ? { found: false, note: `The state's zone layer shows no zone at this point (${asOfText(z)}). Check the official map.` }
          : z.status === 'not_verified'
            ? { found: false, note: z.why, map: z.map }
            : z.status === 'no_point'
              ? { found: false, note: 'This address has no map point from the geocoder, so no zone is looked up.' }
              : { found: false, note: "The state's zoning service did not answer just now. Try again later." },
    landAreaSqm: panel.landAreaSqm,
    landSource: panel.landAreaSqm === null ? null : "the listing's own figure",
    overlays: panel.overlays,
    questions: panel.questions,
    page,
    rules: `${panel.notAPermission} Give the zone and the land size exactly as given here and say where they come from. Never say whether the land can be subdivided or built on, never give a lot count, a yield, a minimum lot size or a value after development, and never say it "suits" any development: give the questions to ask a town planner or the council instead.`,
  };
}
