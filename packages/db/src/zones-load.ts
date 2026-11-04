import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { getDb } from './client';

config({ path: resolve(process.cwd(), '../../.env.local') });
config({ path: resolve(process.cwd(), '../../.env') });

/**
 * Loads South Australia's Planning and Design Code zones into `planning_zone` (ADR 0080, C9 decision 4), from the
 * state's own download (CC BY 3.0 AU, refreshed fortnightly):
 *
 *   curl -L -o zones.zip https://www.dptiapps.com.au/dataportal/PDCodeZones_geojson.zip && unzip zones.zip
 *   pnpm --filter @repo/db db:zones --file /abs/path/PDCodeZones_GDA2020.geojson --published 2026-08-21
 *   pnpm --filter @repo/db db:zones --file … --published … --dry-run   # parse and count, write nothing
 *
 * `--published` is the file's own date (the zip entry's), shown on the panel as "data dated". The file is a download,
 * so every feature is checked before anything is written: GDA2020 only, polygons only, coordinates inside South
 * Australia, a code and a name of the shapes the Code uses. One bad feature stops the load. A reload replaces every
 * SA row in one transaction, so the panel never sees half a state. Polygons are simplified to about a metre
 * (ST_SimplifyPreserveTopology, 0.00001°) — finer than any geocoded address — which keeps the table near 20 MB.
 */

const SOURCE = 'sa_pdcode';
const SIMPLIFY_DEGREES = 0.00001;
const BATCH_BYTES = 4_000_000;
// "GN", "RuL", "E(BH)", "UC(MS)": letters, then at most one bracketed qualifier.
const CODE = /^[A-Za-z]{1,8}(\([A-Za-z]{1,6}\))?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ,()'’/&.-]{1,119}$/;
// South Australia's extent, with a margin: a coordinate outside it is a file we do not understand.
const LNG = [128.5, 141.5] as const;
const LAT = [-38.5, -25.5] as const;

export type ZoneRow = { ref: string; code: string; name: string; geometry: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function checkRing(ring: unknown, where: string): void {
  if (!Array.isArray(ring) || ring.length < 4) throw new Error(`A ring with fewer than 4 points at ${where}`);
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') throw new Error(`A point that is not two numbers at ${where}`);
    if (p[0] < LNG[0] || p[0] > LNG[1] || p[1] < LAT[0] || p[1] > LAT[1]) throw new Error(`A point outside South Australia at ${where}: ${p[0]},${p[1]}`);
  }
}

/** The file → rows, every feature checked. Throws on the first one this loader does not understand. */
export function parseSaZones(text: string): ZoneRow[] {
  const doc = JSON.parse(text) as { type?: unknown; crs?: { properties?: { name?: unknown } }; features?: unknown };
  if (doc.type !== 'FeatureCollection' || !Array.isArray(doc.features)) throw new Error('Not a GeoJSON FeatureCollection');
  if (doc.crs?.properties?.name !== 'EPSG:7844') throw new Error(`Expected the GDA2020 file (EPSG:7844), got ${JSON.stringify(doc.crs?.properties?.name)}`);
  return doc.features.map((f: { type?: unknown; properties?: Record<string, unknown>; geometry?: { type?: unknown; coordinates?: unknown } }, i: number) => {
    const where = `feature ${i}`;
    const p = f.properties ?? {};
    const ref = p.OBJECTID;
    if (typeof ref !== 'number' || !Number.isInteger(ref)) throw new Error(`No OBJECTID at ${where}`);
    const code = typeof p.value === 'string' ? p.value.trim() : '';
    const name = typeof p.name === 'string' ? p.name.trim().replace(/\s+/g, ' ') : '';
    if (!CODE.test(code)) throw new Error(`A zone code of an unknown shape at ${where}: ${JSON.stringify(p.value)}`);
    if (!NAME.test(name)) throw new Error(`A zone name of an unknown shape at ${where}: ${JSON.stringify(p.name)}`);
    if (p.legalenddate != null || p.systemenddate != null) throw new Error(`A zone that has ended at ${where}`);
    const g = f.geometry;
    if (g?.type === 'Polygon' && Array.isArray(g.coordinates)) g.coordinates.forEach((r, j) => checkRing(r, `${where} ring ${j}`));
    else if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates)) g.coordinates.forEach((poly, k) => (Array.isArray(poly) ? poly : [null]).forEach((r, j) => checkRing(r, `${where} part ${k} ring ${j}`)));
    else throw new Error(`Not a polygon at ${where}`);
    return { ref: String(ref), code, name, geometry: JSON.stringify({ type: g.type, coordinates: g.coordinates }) };
  });
}

async function main() {
  const file = arg('file');
  const published = arg('published');
  if (!file) throw new Error('--file <path to PDCodeZones_GDA2020.geojson> is required');
  if (!published || !/^\d{4}-\d{2}-\d{2}$/.test(published) || Number.isNaN(Date.parse(published))) throw new Error('--published YYYY-MM-DD (the file’s own date) is required');
  const rows = parseSaZones(readFileSync(resolve(file), 'utf8'));
  const zones = new Set(rows.map((r) => r.code));
  console.log(`[zones] ${rows.length} polygons, ${zones.size} zones parsed from ${file}`);
  if (process.argv.includes('--dry-run')) return;
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = getDb(url);

  const batches: ZoneRow[][] = [[]];
  let size = 0;
  for (const r of rows) {
    if (size + r.geometry.length > BATCH_BYTES && batches.at(-1)!.length) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1)!.push(r);
    size += r.geometry.length;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from planning_zone where source = ${SOURCE}`);
    for (const [i, batch] of batches.entries()) {
      // MakeValid after simplifying (a simplified ring may touch itself), then the polygons only, as one MultiPolygon.
      await tx.execute(sql`
        insert into planning_zone (state, source, source_ref, zone_code, zone_name, published_on, geom)
        select 'SA', ${SOURCE}, r.ref, r.code, r.name, ${published}::date,
               ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SimplifyPreserveTopology(ST_SetSRID(ST_GeomFromGeoJSON(r.geometry), 4326), ${SIMPLIFY_DEGREES})), 3))
        from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as r(ref text, code text, name text, geometry text)`);
      console.log(`[zones] batch ${i + 1}/${batches.length}: ${batch.length} polygons`);
    }
    const [check] = (await tx.execute<{ n: number; empty: number }>(sql`select count(*)::int as n, count(*) filter (where ST_IsEmpty(geom))::int as empty from planning_zone where source = ${SOURCE}`)) as unknown as [{ n: number; empty: number }];
    if (check.n !== rows.length || check.empty) throw new Error(`Loaded ${check.n} of ${rows.length}, ${check.empty} empty — rolled back`);
  });
  const [{ n, mb }] = (await db.execute<{ n: number; mb: string }>(sql`select count(*)::int as n, pg_size_pretty(pg_total_relation_size('planning_zone')) as mb from planning_zone`)) as unknown as [{ n: number; mb: string }];
  console.log(`[zones] loaded; planning_zone now holds ${n} rows (${mb})`);
  process.exit(0);
}

if (process.argv[1]?.endsWith('zones-load.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
