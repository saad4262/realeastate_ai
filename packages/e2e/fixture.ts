// PLATFORM-PLAN 4.1: the E2E world, made before the run and removed after. Two agencies on the DEV database (never
// production): A with an owner, an agent, a contact, a live listing and a draft; B with an agent. Sign-ins are real
// Supabase Auth users (service-role key), deleted at the end with everything else.
import { readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

export const STATE = new URL('./.e2e-state.json', import.meta.url);
export const PASSWORD = 'E2e-passw0rd-not-secret!';

export type World = {
  tag: string;
  a: { agencyId: string; owner: Person; agent: Person; contactId: string; liveListingId: string; draftListingId: string };
  b: { agencyId: string; agent: Person };
  admin: Person;
};
type Person = { id: string; email: string };

export function env() {
  const db = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!db || !url || !key) throw new Error('E2E needs DIRECT_URL, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the dev project)');
  if ([db, url].some((v) => v.includes('xjklpoyxcvnlhjlxasmv'))) throw new Error('Refusing: E2E never runs against production');
  return { db, url, key };
}

export const sqlClient = () => postgres(env().db, { max: 1, prepare: false });
export const world = (): World => JSON.parse(readFileSync(STATE, 'utf8'));

async function authAdmin(path: string, init: RequestInit) {
  const { url, key } = env();
  const res = await fetch(`${url}/auth/v1/admin/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
  if (!res.ok && !(init.method === 'DELETE' && res.status === 404)) throw new Error(`Auth admin ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

export async function person(sql: postgres.Sql, email: string): Promise<Person> {
  const made = (await authAdmin('users', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }) })) as { id: string };
  await sql`insert into "user" (id, email, name) values (${made.id}, ${email}, ${email.split('@')[0]!}) on conflict (id) do nothing`;
  return { id: made.id, email };
}

export async function seed(): Promise<World> {
  const sql = sqlClient();
  const tag = `e2e${Date.now().toString(36)}`;
  try {
    const agency = async (k: string) => (await sql`insert into agency (name, slug, status) values (${`E2E ${k} ${tag}`}, ${`${tag}-${k}`}, 'active') returning id`)[0]!.id as string;
    const A = await agency('a');
    const B = await agency('b');
    const owner = await person(sql, `${tag}-owner@e2e.test`);
    const agent = await person(sql, `${tag}-agent@e2e.test`);
    const other = await person(sql, `${tag}-other@e2e.test`);
    const admin = await person(sql, `${tag}-admin@e2e.test`);
    await sql`insert into platform_admin (user_id, note) values (${admin.id}, 'e2e')`;
    await sql`insert into membership (user_id, agency_id, role, status) values
      (${owner.id}, ${A}, 'owner', 'active'), (${agent.id}, ${A}, 'agent', 'active'), (${other.id}, ${B}, 'agent', 'active')`;
    const contactId = (await sql`insert into contact (agency_id, name, email, assigned_to) values (${A}, ${`Cora ${tag}`}, ${`cora.${tag}@e2e.test`}, ${agent.id}) returning id`)[0]!.id as string;
    const listing = async (status: 'live' | 'draft', n: number) => {
      const [p] = await sql`insert into property (street_number, street, suburb, postcode, state, formatted_address, property_type, bedrooms)
        values (${String(n)}, 'E2E Street', 'Richmond', '3121', 'VIC', ${`${n} E2E Street, Richmond VIC 3121`}, 'house', 3) returning id`;
      const [l] = await sql`insert into listing (property_id, agency_id, channel, status, headline, price_display, price_from, published_at)
        values (${p!.id}, ${A}, 'sale', ${status}, ${`E2E ${status} ${tag}`}, '$900,000', 900000, ${status === 'live' ? sql`now()` : null}) returning id`;
      await sql`insert into listing_agent (listing_id, user_id, role, snapshot_name, snapshot_phone, snapshot_email) values (${l!.id}, ${agent.id}, 'lead', 'E2E Agent', '0400 000 000', ${agent.email})`;
      return l!.id as string;
    };
    const w: World = { tag, a: { agencyId: A, owner, agent, contactId, liveListingId: await listing('live', 1), draftListingId: await listing('draft', 2) }, b: { agencyId: B, agent: other }, admin };
    writeFileSync(STATE, JSON.stringify(w, null, 2));
    return w;
  } finally {
    await sql.end();
  }
}

export async function teardown(): Promise<void> {
  // Everything any E2E run made (slugs and emails start `e2e`), so a run that died half-way is cleaned up too.
  const sql = sqlClient();
  try {
    const agencies = (await sql`select id from agency where slug ~ '^e2e[a-z0-9]+-[ab]$'`).map((r) => r.id as string);
    if (agencies.length) {
      const props = await sql`select property_id from listing where agency_id in ${sql(agencies)}`;
      await sql`delete from listing where agency_id in ${sql(agencies)}`;
      if (props.length) await sql`delete from property where id in ${sql(props.map((p) => p.property_id as string))}`;
      await sql`delete from agency where id in ${sql(agencies)}`;
    }
    await sql`delete from job where dedupe_key like 'evt_e2e%'`;
    await sql`delete from stripe_event where id like 'evt_e2e%'`;
    await sql`delete from lead where email like '%@e2e.test'`;
    for (const u of await sql`select id from "user" where email like 'e2e%@e2e.test'`) {
      await authAdmin(`users/${u.id}`, { method: 'DELETE' });
      await sql`delete from "user" where id = ${u.id}`;
    }
  } finally {
    await sql.end();
  }
}
