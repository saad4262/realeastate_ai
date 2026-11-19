// PLATFORM-PLAN 4.3: writes load/targets.json (listing ids and suburbs to request) from the database the
// load test's target uses. Read-only. Refuses production. Run: node load/targets.mjs (DIRECT_URL set).
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The driver the app uses, resolved from packages/db (the repository root has no dependencies of its own).
const postgres = createRequire(new URL('../packages/db/package.json', import.meta.url))('postgres');

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DIRECT_URL is not set');
if (url.includes('xjklpoyxcvnlhjlxasmv')) throw new Error('Refusing: that is the production database');
const sql = postgres(url, { max: 1, prepare: false });
const listings = (await sql`select id from listing where status in ('live', 'under_offer', 'sold') order by random() limit 2000`).map((r) => r.id);
const suburbs = (await sql`select distinct p.suburb from listing l join property p on p.id = l.property_id where l.status = 'live' and p.suburb is not null limit 300`).map((r) => r.suburb);
await sql.end();
if (!listings.length || !suburbs.length) throw new Error(`Nothing to request (listings ${listings.length}, suburbs ${suburbs.length}): seed the database first (load/seed.sql)`);
const consolePaths = ['/my-contacts', '/my-leads', '/listings', '/my-calendar', '/my-inbox', '/my-pipeline'];
writeFileSync(new URL('./targets.json', import.meta.url), JSON.stringify({ listings, suburbs, consolePaths }));
console.log(`targets.json: ${listings.length} listings, ${suburbs.length} suburbs, ${consolePaths.length} console paths`);
