// PLATFORM-PLAN 4.3: before the load, each request of catalog.js ALONE — how long one call takes (first call, then a
// second one that may be cached) and how many database statements it runs (pg_stat_statements, before and after).
// With the database's round trip, that explains the load run: a call of N statements cannot be faster than N round
// trips, and a pool of P connections cannot serve more than P / round trip statements a second.
// node load/profile.mjs <out.json>   (.env.dev loaded, the servers running). Refuses production.
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ENDPOINTS, SESSION_OF, baseUrl, body, fill } from './catalog.js';

const postgres = createRequire(new URL('../packages/db/package.json', import.meta.url))('postgres');
const out = process.argv[2];
const dbUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!out || !dbUrl) throw new Error('usage: node load/profile.mjs <out.json> (DIRECT_URL set)');
if (dbUrl.includes('xjklpoyxcvnlhjlxasmv')) throw new Error('Refusing: that is the production database');

const targets = JSON.parse(readFileSync(new URL('./targets.json', import.meta.url), 'utf8'));
let sessions = {};
try {
  sessions = JSON.parse(readFileSync(new URL('./sessions.json', import.meta.url), 'utf8'));
} catch {
  sessions = {};
}
const pick = (list) => list[0]; // the same ids every time, so the second call can hit a cache
const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = postgres(dbUrl, { max: 1, prepare: false });
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// The round trip from where the app servers run (this machine, when they run here) to the database.
await sql`select 1`;
const trips = [];
for (let i = 0; i < 7; i += 1) {
  const t = performance.now();
  await sql`select 1`;
  trips.push(performance.now() - t);
}
const rttMs = median(trips);

const statements = async () => Number((await sql`select coalesce(sum(calls), 0)::bigint as n from pg_stat_statements`)[0].n);
// Other traffic on the same database (another developer, a cron, Supabase's own monitoring) counts too: measure it
// with nothing sent, before every request, and take the median rate off each call's count (a burst from someone
// else's run must not wipe a real count to 0). The raw count is kept. A busy database makes every count unreliable:
// report.mjs then says so (noiseMeanPerSec).
const noiseRates = []; // statements per ms
async function noise() {
  const a = await statements();
  await wait(1500);
  const n = Math.max(0, (await statements()) - a - 1);
  noiseRates.push(n / 1500);
  return n;
}
const meanNoise = () => noiseRates.reduce((s, r) => s + r, 0) / noiseRates.length;
const medianNoise = () => [...noiseRates].sort((a, b) => a - b)[Math.floor(noiseRates.length / 2)];
const noiseBefore = await noise();

async function call(e) {
  const pool = SESSION_OF[e.role];
  const headers = { 'x-forwarded-for': '10.0.0.1' };
  if (process.env.VERCEL_BYPASS) headers['x-vercel-protection-bypass'] = process.env.VERCEL_BYPASS;
  if (pool) headers.cookie = sessions[pool][0];
  const payload = body(e.kind, targets, pick, `profile_${Date.now()}`);
  if (payload) headers['content-type'] = 'application/json';
  if (e.kind === 'system_stripe_webhook') {
    const t = Math.floor(Date.now() / 1000);
    headers['stripe-signature'] = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
  }
  const started = performance.now();
  try {
    const res = await fetch(`${baseUrl(e.role, e.kind, process.env)}${fill(e.path, targets, pick)}`, {
      method: e.method, headers, body: payload ?? undefined, redirect: 'manual', signal: AbortSignal.timeout(60_000),
    });
    const firstByteMs = performance.now() - started;
    const bytes = (await res.arrayBuffer()).byteLength;
    return { status: res.status, firstByteMs, totalMs: performance.now() - started, bytes };
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err), firstByteMs: null, totalMs: performance.now() - started, bytes: 0 };
  }
}

const endpoints = {};
const usable = ENDPOINTS.filter((e) => (!SESSION_OF[e.role] || (sessions[SESSION_OF[e.role]] || []).length) && (e.kind !== 'system_stripe_webhook' || secret));
for (const e of usable) {
  await noise();
  const runs = [];
  for (const label of ['first', 'second']) {
    const before = await statements();
    const t = performance.now();
    const r = await call(e);
    await wait(1200); // work a route does after answering (`after()`) is counted too
    const raw = Math.max(0, (await statements()) - before - 1);
    runs.push({ label, ...r, statementsRaw: raw, statements: Math.max(0, raw - Math.round(medianNoise() * (performance.now() - t))) });
  }
  endpoints[e.kind] = { first: runs[0], second: runs[1] };
  const f = runs[0];
  console.log(`${e.kind.padEnd(34)} ${String(f.status).padStart(3)}  ${Math.round(f.totalMs)} ms, ${f.statements} statements; again ${Math.round(runs[1].totalMs)} ms, ${runs[1].statements}`);
}
const noiseAfter = await noise();
await sql.end();

writeFileSync(out, JSON.stringify({
  at: new Date().toISOString(), rttMs, trips, noisePer1500ms: [noiseBefore, noiseAfter], noiseMeanPerSec: meanNoise() * 1000,
  poolMax: Number(process.env.DB_POOL_MAX || 5), endpoints,
}, null, 1));
console.log(`round trip to the database ${rttMs.toFixed(0)} ms; other traffic ${(meanNoise() * 1000).toFixed(1)} statements/s on average (taken off each count)`);
