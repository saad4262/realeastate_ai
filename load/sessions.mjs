// PLATFORM-PLAN 4.3: signs in seeded agents, owners, buyers and the admin so k6 can open their pages. Writes load/sessions.json.
// Each seeded person gets a Supabase Auth user with the SAME id as its "user" row (CLAUDE.md #14) and a password
// made for this run only. DEV only: refuses production. Run with .env.dev loaded:
//   node load/sessions.mjs            (agents 20, owners 10, buyers 10, the admin: SESSIONS_AGENT/OWNER/BUYER)
//   node load/sessions.mjs --delete   (removes the load-* Auth users; cleanup.sql removes the rows)
// Sessions last as long as the project's access token (refreshing them from many VUs at once would trip
// Supabase's refresh-token reuse check), so make them right before a run.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const fromAuth = createRequire(new URL('../packages/auth/package.json', import.meta.url));
const { createClient } = fromAuth('@supabase/supabase-js');
const { createServerClient } = fromAuth('@supabase/ssr');
const postgres = createRequire(new URL('../packages/db/package.json', import.meta.url))('postgres');

const PROD = 'xjklpoyxcvnlhjlxasmv';
const dbUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable, SUPABASE_SERVICE_ROLE_KEY: service } = process.env;
if (!dbUrl || !url || !publishable || !service) throw new Error('Load .env.dev first: DIRECT_URL and the three Supabase keys');
if ((dbUrl + url).includes(PROD)) throw new Error('Refusing: that is the production project');

const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

if (process.argv.includes('--delete')) {
  let deleted = 0;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const load = data.users.filter((u) => /^load-.*@load\.test$/.test(u.email ?? ''));
    for (const u of load) {
      const { error: e } = await admin.auth.admin.deleteUser(u.id);
      if (e) throw e;
      deleted += 1;
    }
    if (data.users.length < 1000) break;
  }
  console.log(`deleted ${deleted} load-* Auth users`);
  process.exit(0);
}

// How many people of each kind sign in (k6 spreads its virtual users over them). Emails from seed.sql.
const WANT = {
  agent: { n: Number(process.env.SESSIONS_AGENT ?? 20), re: '^load-[0-9]+-([2-9]|[1-9][0-9]+)@load\\.test$' },
  owner: { n: Number(process.env.SESSIONS_OWNER ?? 10), re: '^load-[0-9]+-1@load\\.test$' },
  buyer: { n: Number(process.env.SESSIONS_BUYER ?? 10), re: '^load-buyer-[0-9]+@load\\.test$' },
  admin: { n: 1, re: '^load-admin@load\\.test$' },
};
const sql = postgres(dbUrl, { max: 1, prepare: false });
const people = {};
for (const [role, { n, re }] of Object.entries(WANT)) {
  people[role] = await sql`select id, email from "user" where email ~ ${re} order by email limit ${n}`;
}
await sql.end();
if (!people.agent.length) throw new Error('No seeded agents: run load/seed.sql with agents >= 2');

async function signIn(person) {
  const password = randomBytes(18).toString('base64url');
  const made = await admin.auth.admin.createUser({ id: person.id, email: person.email, password, email_confirm: true });
  if (made.error) {
    const { error } = await admin.auth.admin.updateUserById(person.id, { password });
    if (error) throw new Error(`${person.email}: ${made.error.message}; then ${error.message}`);
  }
  // The same cookie the apps' middleware reads, written by the same library.
  const jar = new Map();
  const client = createServerClient(url, publishable, {
    cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (list) => list.forEach((c) => jar.set(c.name, c.value)) },
  });
  const { error } = await client.auth.signInWithPassword({ email: person.email, password });
  if (error) throw new Error(`${person.email}: ${error.message}`);
  return [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
}

const sessions = {};
for (const [role, list] of Object.entries(people)) {
  sessions[role] = [];
  for (const person of list) sessions[role].push(await signIn(person));
}
writeFileSync(new URL('./sessions.json', import.meta.url), JSON.stringify(sessions));
console.log(`sessions.json: ${Object.entries(sessions).map(([r, l]) => `${l.length} ${r}`).join(', ')}`);
