// PLATFORM-PLAN 4.3: writes load/targets.json (what to request) from the database the load test's target uses.
// Read-only. Refuses production. Run: node load/targets.mjs (DIRECT_URL set).
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The driver the app uses, resolved from packages/db (the repository root has no dependencies of its own).
const postgres = createRequire(new URL('../packages/db/package.json', import.meta.url))('postgres');

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DIRECT_URL is not set');
if (url.includes('xjklpoyxcvnlhjlxasmv')) throw new Error('Refusing: that is the production database');
const sql = postgres(url, { max: 1, prepare: false });
const listings = (await sql`select id from listing where status in ('live', 'under_offer', 'sold') order by random() limit 2000`).map((r) => r.id);
const properties = (await sql`select distinct property_id as id from listing where status in ('live', 'sold') limit 2000`).map((r) => r.id);
const places = await sql`select distinct p.suburb, p.state from listing l join property p on p.id = l.property_id
  where l.status = 'live' and p.suburb is not null and p.state is not null limit 300`;
const agencies = (await sql`select id from agency where slug like 'load-%' order by random() limit 200`).map((r) => r.id);
await sql.end();
if (!listings.length || !places.length) throw new Error(`Nothing to request (listings ${listings.length}, suburbs ${places.length}): seed the database first (load/seed.sql)`);
const suburbs = places.map((p) => p.suburb);
// The same URL the site links to (apps/web suburb links).
const suburbPaths = places.map((p) => `/suburb/${p.state.trim().toLowerCase()}/${encodeURIComponent(p.suburb.trim().toLowerCase().replace(/\s+/g, '-'))}`);
// Which pages each role opens is in catalog.js; this file only holds the ids they open.
writeFileSync(new URL('./targets.json', import.meta.url), JSON.stringify({ listings, properties, suburbs, suburbPaths, agencies }));
console.log(`targets.json: ${listings.length} listings, ${properties.length} properties, ${suburbs.length} suburbs, ${agencies.length} agencies`);
