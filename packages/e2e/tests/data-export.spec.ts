// ADR 0104, TEST-PLAN DA1–DA18: the quick CSVs and the full export, in a browser, on the DEV database, with the real
// Storage and (once, to Resend's test inbox) the real email. The export job runs here through the real queue
// (`runJobs`, bulk lane) instead of the whole minute tick, which would also run every other due job on dev.
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Download, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { env, sqlClient, world } from '../fixture';
import { urls } from '../playwright.config';
import { passwordSession, signIn, useSession } from './helpers';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../core/src/imports/csv';

// A dev server compiles each console page on first visit; these tests open many.
test.describe.configure({ mode: 'serial', timeout: 600_000 });

const sql = sqlClient();
const storage = (path: string, init: RequestInit = {}) => {
  const { url, key } = env();
  return fetch(`${url}/storage/v1/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });
};
// The smallest JPEG and PDF that are what they say they are.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

type Seed = { enquiryContact: string; offerContact: string; photoKey: string; photoId: string; docKey: string; docId: string; formula: string; accent: string; archived: string; ownersOwn: string; offer: string; enquiry: string; ownerAppt: string; openDeal: string; settledDeal: string; secretNote: string; agentPrivate: string; publicNote: string };
let seed: Seed;
const sent: { id: string; to: string }[] = [];

async function as(browser: Browser, base: string, email: string): Promise<Page> {
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await signIn(page, base, email);
  return page;
}
/**
 * Click and wait for the file. Once, a click is tried again: a dev server reloads a page when it first compiles a
 * route (cancelling the download), and the console's live refresh re-renders the page when a bell arrives (a click
 * at that moment lands on the old element). A second failure is a real one.
 */
async function download(page: Page, click: () => Promise<void>, retry = true): Promise<{ d: Download; bytes: Buffer }> {
  try {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: retry ? 30_000 : 120_000 }), click()]);
    return { d, bytes: readFileSync((await d.path())!) };
  } catch (err) {
    if (!retry || !/canceled|Timeout/.test(String(err))) throw err;
    await page.waitForTimeout(2_000);
    return download(page, click, false);
  }
}
/** A CSV file as rows keyed by header; the BOM checked and removed. */
function rows(bytes: Buffer | Uint8Array): Record<string, string>[] {
  const text = Buffer.from(bytes).toString('utf8');
  expect(text.charCodeAt(0), 'starts with a byte-order mark').toBe(0xfeff);
  const body = text.slice(1);
  if (body.split('\r\n').filter(Boolean).length < 2) return [];
  const { headers, rows: r } = parseCsv(body);
  return r.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])));
}
const ids = (r: Record<string, string>[]) => r.map((x) => x.id).sort();

/** The real queue's bulk lane and real Storage, in the smoke package's runner; `--mail` sends to the requester (Resend). */
const SMOKE = fileURLToPath(new URL('../../smoke', import.meta.url));
function runner(...args: string[]): Record<string, unknown> {
  const out = execFileSync('npx', ['tsx', 'src/run-export-jobs.ts', ...args], { cwd: SMOKE, encoding: 'utf8', timeout: 600_000 });
  return JSON.parse(out.trim().split('\n').pop()!);
}
async function buildExports(mail: boolean) {
  const r = runner(...(mail ? ['--mail'] : [])) as { sent: { id: string; to: string }[] };
  sent.push(...r.sent);
}

test.beforeAll(async () => {
  const w = world();
  const A = w.a.agencyId;
  const contact = async (name: string, assigned: string | null, extra = sql``) =>
    (await sql`insert into contact (agency_id, name, email, phone, address_line, address_suburb, address_state, address_postcode, assigned_to)
      values (${A}, ${name}, ${`${name.replace(/\W/g, '').toLowerCase()}.${w.tag}@e2e.test`}, '0412 345 678', '1 Test St', 'Richmond', 'VIC', '3121', ${assigned}) returning id`)[0]!.id as string;
  const formula = await contact('=1+1', w.a.agent.id);
  const accent = await contact(`Zoë Müller ${w.tag}`, w.a.agent.id);
  await sql`insert into contact_role (contact_id, role) values (${accent}, 'buyer')`;
  const archived = await contact(`Archie ${w.tag}`, w.a.agent.id);
  await sql`update contact set archived_at = now() where id = ${archived}`;
  await sql`insert into contact_role (contact_id, role) values (${archived}, 'buyer')`;
  const ownersOwn = await contact(`Olga ${w.tag}`, w.a.owner.id);
  const [prop] = await sql`select property_id from listing where id = ${w.a.liveListingId}`;
  const lead = async (kind: string, amount: number | null) =>
    (await sql`insert into lead (property_id, listing_id, agency_id, name, email, message, kind, offer_amount)
      values (${prop!.property_id}, ${w.a.liveListingId}, ${A}, ${`Lee ${kind} ${w.tag}`}, ${`lee.${kind}.${w.tag}@e2e.test`}, 'e2e', ${kind}::lead_kind, ${amount}) returning id`)[0]!.id as string;
  const enquiry = await lead('enquiry', null);
  const offer = await lead('offer', 905000);
  const appt = async (who: string, days: number, status: string) =>
    (await sql`insert into appointment (agency_id, kind, contact_id, title, type, starts_at, ends_at, timezone, status, assigned_agent_id, created_by)
      values (${A}, 'client', ${w.a.contactId}, ${`Appt ${days} ${w.tag}`}, 'appraisal', now() + ${`${days} days`}::interval, now() + ${`${days} days`}::interval + interval '1 hour',
              'Australia/Melbourne', ${status}::appointment_status, ${who}, ${who}) returning id`)[0]!.id as string;
  await appt(w.a.agent.id, -3, 'completed');
  await appt(w.a.agent.id, 3, 'scheduled');
  const ownerAppt = await appt(w.a.owner.id, 4, 'scheduled');
  const openDeal = (await sql`insert into deal (agency_id, property_id, listing_id, stage, status, agent_id) values (${A}, ${prop!.property_id}, ${w.a.liveListingId}, 'marketing', 'open', ${w.a.agent.id}) returning id`)[0]!.id as string;
  const [p2] = await sql`insert into property (street_number, street, suburb, postcode, state) values ('9', 'Settled St', 'Richmond', '3121', 'VIC') returning id`;
  const settledDeal = (await sql`insert into deal (agency_id, property_id, stage, status, agent_id, sale_price, settled_at) values (${A}, ${p2!.id}, 'settlement', 'settled', ${w.a.owner.id}, 1200000, now()) returning id`)[0]!.id as string;
  const note = async (author: string, body: string, isPrivate: boolean) =>
    (await sql`insert into note (agency_id, contact_id, author_id, body, is_private) values (${A}, ${w.a.contactId}, ${author}, ${body}, ${isPrivate}) returning id`)[0]!.id as string;
  const publicNote = await note(w.a.agent.id, 'Public note', false);
  const secretNote = await note(w.a.owner.id, 'Owner private note', true);
  const agentPrivate = await note(w.a.agent.id, 'Agent private note', true);
  // A real photo in the public media bucket and a real PDF in the private documents bucket.
  const photoKey = `listing/${w.a.liveListingId}/e2e-${w.tag}.jpg`;
  expect((await storage(`object/media/${photoKey}`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: JPEG })).ok).toBe(true);
  const photoId = (await sql`insert into media (listing_id, kind, storage_key, is_main) values (${w.a.liveListingId}, 'photo', ${photoKey}, true) returning id`)[0]!.id as string;
  const docKey = `agency/${A}/e2e-${w.tag}.pdf`;
  expect((await storage(`object/documents/${docKey}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: PDF })).ok).toBe(true);
  const docId = (await sql`insert into document (agency_id, contact_id, title, storage_key, mime_type, size_bytes, uploaded_by, status)
    values (${A}, ${w.a.contactId}, 'Contract of sale.pdf', ${docKey}, 'application/pdf', ${PDF.length}, ${w.a.owner.id}, 'ready') returning id`)[0]!.id as string;
  const contactOf = async (leadId: string) => (await sql`select contact_id from lead where id = ${leadId}`)[0]!.contact_id as string;
  seed = { enquiryContact: await contactOf(enquiry), offerContact: await contactOf(offer), photoKey, photoId, docKey, docId, formula, accent, archived, ownersOwn, offer, enquiry, ownerAppt, openDeal, settledDeal, secretNote, agentPrivate, publicNote };
});

test.afterAll(async () => {
  const w = world();
  await sql`update "user" set email = ${w.a.owner.email} where id = ${w.a.owner.id}`;
  if (seed) for (const p of [`object/media/${seed.photoKey}`, `object/documents/${seed.docKey}`]) await storage(p, { method: 'DELETE' });
  await sql.end();
});

test('DA1, DA2, DA6: customers as CSV — the directory, its filters, a BOM, a formula that does not run', async ({ browser }) => {
  const w = world();
  const owner = await as(browser, urls.agency, w.a.owner.email);
  await owner.goto(`${urls.agency}/customers`);
  const all = await download(owner, () => owner.getByRole('link', { name: 'Export CSV' }).click());
  expect(all.d.suggestedFilename()).toMatch(/^customers-\d{4}-\d{2}-\d{2}\.csv$/);
  const r = rows(all.bytes);
  const live = (await sql`select id from contact where agency_id = ${w.a.agencyId} and archived_at is null and merged_into_id is null`).map((x) => x.id as string).sort();
  expect(ids(r)).toEqual(live);
  expect(r.find((x) => x.id === seed.accent)!.name).toBe(`Zoë Müller ${w.tag}`);
  expect(r.find((x) => x.id === seed.formula)!.name).toBe("'=1+1");
  await owner.goto(`${urls.agency}/customers?role=buyer&archived=all`);
  const filtered = rows((await download(owner, () => owner.getByRole('link', { name: 'Export CSV' }).click())).bytes);
  // Every buyer, archived too: ours, and the people the seeded enquiry and offer made (a lead makes its contact a buyer).
  const buyers = (await sql`select c.id from contact c where c.agency_id = ${w.a.agencyId} and c.merged_into_id is null
    and exists (select 1 from contact_role r where r.contact_id = c.id and r.role = 'buyer')`).map((x) => x.id as string).sort();
  expect(buyers).toEqual(expect.arrayContaining([seed.accent, seed.archived]));
  expect(ids(filtered)).toEqual(buyers);
  expect(filtered.find((x) => x.id === seed.archived)!.archived).toBe('yes');
});

test('DA3, DA12: an agent’s contacts and notes are theirs; another member’s private note never appears', async ({ browser }) => {
  const w = world();
  const agent = await as(browser, urls.agent, w.a.agent.email);
  await agent.goto(`${urls.agent}/my-contacts`);
  const r = rows((await download(agent, () => agent.getByRole('link', { name: 'Export CSV' }).click())).bytes);
  // Their own, and the buyer who enquired through their listing; never the owner's own, never the offer's.
  expect(ids(r)).toEqual([w.a.contactId, seed.formula, seed.accent, seed.enquiryContact].sort());
  expect(ids(r)).not.toContain(seed.ownersOwn);
  expect(ids(r)).not.toContain(seed.offerContact);
  const notes = rows((await download(agent, () => agent.getByRole('link', { name: 'Export notes' }).click())).bytes);
  expect(ids(notes)).toEqual([seed.publicNote, seed.agentPrivate].sort());
});

test('DA4, DA5: listings — the owner’s book, the agent’s own; the file goes back in through the import', async ({ browser }) => {
  const w = world();
  const owner = await as(browser, urls.agency, w.a.owner.email);
  await owner.goto(`${urls.agency}/live-listings`);
  const book = rows((await download(owner, () => owner.getByRole('link', { name: /Export CSV/ }).click())).bytes);
  expect(ids(book)).toEqual([w.a.liveListingId, w.a.draftListingId].sort());
  const live = book.find((x) => x.id === w.a.liveListingId)!;
  expect(live.photo_urls).toContain(seed.photoKey);
  expect(live.price_from).toBe('900000');

  const other = await as(browser, urls.agent, w.b.agent.email);
  await other.goto(`${urls.agent}/listings`);
  const empty = rows((await download(other, () => other.getByRole('link', { name: /Export CSV/ }).click())).bytes);
  expect(empty).toEqual([]);
  // DA5: the owner's file into agency B, through the import's own screens.
  const file = (await download(owner, () => owner.getByRole('link', { name: /Export CSV/ }).click())).bytes;
  await other.goto(`${urls.agent}/listings/import`);
  await other.locator('input[type="file"]').setInputFiles({ name: `listings-${w.tag}.csv`, mimeType: 'text/csv', buffer: file });
  await other.getByRole('button', { name: /upload and match columns/i }).click();
  await other.getByRole('button', { name: /check every row/i }).click();
  await expect(other.getByText(/2 ready · 0 with problems/).first()).toBeVisible({ timeout: 120_000 });
});

test('DA9, DA10, DA11: leads, calendar and pipeline, each as its screen shows it', async ({ browser }) => {
  const w = world();
  const owner = await as(browser, urls.agency, w.a.owner.email);
  await owner.goto(`${urls.agency}/leads?kind=offer`);
  const offers = rows((await download(owner, () => owner.getByRole('link', { name: 'Export CSV' }).click())).bytes);
  expect(ids(offers)).toEqual([seed.offer]);
  expect(offers[0]!.offer_amount).toBe('905000');
  const agent = await as(browser, urls.agent, w.a.agent.email);
  await agent.goto(`${urls.agent}/my-leads`);
  const theirs = rows((await download(agent, () => agent.getByRole('link', { name: 'Export CSV' }).click())).bytes);
  expect(ids(theirs)).toContain(seed.enquiry);
  expect(ids(theirs)).not.toContain(seed.offer);

  await agent.goto(`${urls.agent}/my-calendar`);
  const cal = rows((await download(agent, () => agent.getByRole('link', { name: 'Export CSV' }).click())).bytes);
  expect(cal).toHaveLength(2);
  expect(ids(cal)).not.toContain(seed.ownerAppt);
  expect(cal.every((x) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.starts_at!))).toBe(true);
  await owner.goto(`${urls.agency}/calendar`);
  expect(rows((await download(owner, () => owner.getByRole('link', { name: 'Export CSV' }).click())).bytes)).toHaveLength(3);

  await owner.goto(`${urls.agency}/pipeline`);
  expect(ids(rows((await download(owner, () => owner.getByRole('link', { name: 'Export CSV' }).click())).bytes))).toEqual([seed.openDeal, seed.settledDeal].sort());
  await owner.goto(`${urls.agency}/pipeline?mine=1`);
  expect(ids(rows((await download(owner, () => owner.getByRole('link', { name: 'Export CSV' }).click())).bytes))).toEqual([seed.settledDeal]);
  await agent.goto(`${urls.agent}/my-pipeline`);
  expect(ids(rows((await download(agent, () => agent.getByRole('link', { name: 'Export CSV' }).click())).bytes))).toEqual([seed.openDeal]);
});

test('DA7, DA8: every download is in the owner’s audit log; a platform admin cannot export', async ({ browser }) => {
  const w = world();
  const owner = await as(browser, urls.agency, w.a.owner.email);
  await owner.goto(`${urls.agency}/settings/audit`);
  await expect(owner.getByText(/Downloaded contacts as CSV \(\d+ rows?\)/).first()).toBeVisible();
  await expect(owner.getByText(/Downloaded listings as CSV/).first()).toBeVisible();
  const ctx = await browser.newContext();
  await useSession(ctx, 'http://admin.lvh.me:3001', await passwordSession(w.admin.email));
  const admin = await ctx.newPage();
  // The admin host serves nothing of an agency's console (ADR 0049); on the agency host the admin has no agency.
  for (const base of ['http://admin.lvh.me:3001', urls.agency]) {
    const res = await admin.request.get(`${base}/api/exports/contacts`, { maxRedirects: 0 });
    console.log(`DA8 ${base}: ${res.status()} ${res.headers()['location'] ?? ''}`);
    expect(res.status()).not.toBe(200);
    expect(res.headers()['content-type'] ?? '').not.toContain('text/csv');
  }
  await admin.goto(`http://admin.lvh.me:3001/agencies/${w.a.agencyId}/customers`);
  await expect(admin.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
});

test('DA13, DA14, DA16: the owner’s full export — real storage, the real email, files only the owner can open', async ({ browser }) => {
  const w = world();
  const owner = await as(browser, urls.agency, w.a.owner.email);
  await owner.goto(`${urls.agency}/settings`);
  await owner.getByRole('link', { name: /Download your data/ }).click();
  await owner.getByRole('button', { name: 'Prepare my data' }).click();
  await expect(owner.getByText(/Waiting to start|Being prepared/).first()).toBeVisible();
  await expect(owner.getByRole('button', { name: /Being prepared/ })).toBeDisabled();
  // The email goes to Resend's test inbox: the owner's address in OUR table only, put back in afterAll.
  await sql`update "user" set email = ${`delivered+${w.tag}@resend.dev`} where id = ${w.a.owner.id}`;
  await buildExports(true);
  await sql`update "user" set email = ${w.a.owner.email} where id = ${w.a.owner.id}`;
  await owner.reload();
  await expect(owner.getByText('Ready', { exact: true }).first()).toBeVisible();
  for (const name of ['data.zip', 'photos-1.zip', 'documents-1.zip']) await expect(owner.getByRole('link', { name })).toBeVisible();

  const data = unzipSync((await download(owner, () => owner.getByRole('link', { name: 'data.zip' }).click())).bytes);
  for (const f of ['README.txt', 'customers.csv', 'listings.csv', 'leads.csv', 'appointments.csv', 'deals.csv', 'notes.csv', 'activity.csv', 'sms.csv', 'calls.csv', 'emails.csv', 'documents.csv', 'photos.csv', 'team.csv']) {
    expect(Object.keys(data), f).toContain(f);
  }
  expect(ids(rows(data['customers.csv']!))).toContain(seed.archived);
  expect(ids(rows(data['notes.csv']!))).toContain(seed.secretNote);
  // Built while the owner's address was Resend's test inbox (above), so that is the address the team file holds.
  expect(rows(data['team.csv']!).map((x) => x.email).sort()).toEqual([w.a.agent.email, `delivered+${w.tag}@resend.dev`].sort());
  const photoFile = rows(data['photos.csv']!).find((x) => x.id === seed.photoId)!.file!;
  const photos = unzipSync((await download(owner, () => owner.getByRole('link', { name: 'photos-1.zip' }).click())).bytes);
  expect(Buffer.from(photos[photoFile]!).equals(JPEG)).toBe(true);
  const docFile = rows(data['documents.csv']!).find((x) => x.id === seed.docId)!.file!;
  const docs = unzipSync((await download(owner, () => owner.getByRole('link', { name: 'documents-1.zip' }).click())).bytes);
  expect(Buffer.from(docs[docFile]!).equals(PDF)).toBe(true);
  expect(strFromU8(data['README.txt']!)).toContain('the whole agency');

  // The bell, and the email Resend accepted and delivered.
  expect(Number((await sql`select count(*)::int as n from notification where user_id = ${w.a.owner.id} and kind = 'data_export_ready'`)[0]!.n)).toBe(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toBe(`delivered+${w.tag}@resend.dev`);
  const key = process.env.RESEND_API_KEY!;
  await expect.poll(async () => ((await (await fetch(`https://api.resend.com/emails/${sent[0]!.id}`, { headers: { authorization: `Bearer ${key}` } })).json()) as { last_event?: string }).last_event, { timeout: 60_000 }).toBe('delivered');

  // DA16: the agent opens the owner's link: not found.
  const [exp] = await sql`select id from export_job where user_id = ${w.a.owner.id} order by created_at desc limit 1`;
  const agent = await as(browser, urls.agent, w.a.agent.email);
  const res = await agent.request.get(`${urls.agent}/api/exports/full/${exp!.id}/data.zip`, { maxRedirects: 0 });
  expect(res.status()).toBe(404);
});

test('DA15, DA17: the agent’s full export is their own slice; a sixth in a day is refused', async ({ browser }) => {
  const w = world();
  const agent = await as(browser, urls.agent, w.a.agent.email);
  await agent.goto(`${urls.agent}/my-data`);
  await agent.getByRole('button', { name: 'Prepare my data' }).click();
  // The row exists once the page says so; only then is there a job to run.
  await expect(agent.getByText(/Waiting to start|Being prepared/).first()).toBeVisible();
  await buildExports(false);
  await agent.reload();
  await expect(agent.getByText('Ready', { exact: true }).first()).toBeVisible();
  const data = unzipSync((await download(agent, () => agent.getByRole('link', { name: 'data.zip' }).click())).bytes);
  expect(Object.keys(data)).not.toContain('team.csv');
  expect(ids(rows(data['customers.csv']!))).toEqual([w.a.contactId, seed.formula, seed.accent, seed.archived, seed.enquiryContact].sort());
  expect(ids(rows(data['notes.csv']!))).not.toContain(seed.secretNote);
  expect(ids(rows(data['leads.csv']!))).not.toContain(seed.offer);
  expect(ids(rows(data['deals.csv']!))).toEqual([seed.openDeal]);
  // DA17: four more today make five; the sixth is refused with the reason.
  for (let i = 0; i < 4; i += 1) await sql`insert into export_job (agency_id, user_id, status) values (${w.a.agencyId}, ${w.a.agent.id}, 'failed')`;
  await agent.getByRole('button', { name: 'Prepare my data' }).click();
  // Next.js keeps its own role=alert route announcer on the page; ours is the one with the reason.
  await expect(agent.getByRole('alert').filter({ hasText: 'You can prepare 5 exports a day' })).toBeVisible();
});

test('DA18: 24 hours later every file is deleted and the page says so', async ({ browser }) => {
  const w = world();
  const keys = (await sql`select objects from export_job where agency_id = ${w.a.agencyId} and status = 'ready'`).flatMap((r) => r.objects as string[]);
  expect(keys.length).toBeGreaterThan(3);
  for (const k of keys) expect((await storage(`object/info/documents/${k}`)).ok, k).toBe(true);
  const r = runner('--expire-in-hours=25') as { expired: number };
  expect(r.expired).toBeGreaterThanOrEqual(2);
  for (const k of keys) expect((await storage(`object/info/documents/${k}`)).ok, k).toBe(false);
  const owner = await as(browser, urls.agency, w.a.owner.email);
  await owner.goto(`${urls.agency}/settings/data`);
  await expect(owner.getByText('Deleted', { exact: true }).first()).toBeVisible();
  await expect(owner.getByRole('link', { name: 'data.zip' })).toHaveCount(0);
});
