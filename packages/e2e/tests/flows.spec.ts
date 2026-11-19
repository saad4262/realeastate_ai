// PLATFORM-PLAN 4.1: the five flows a customer would notice first if they broke.
import { expect, test } from '@playwright/test';
import { sqlClient, world } from '../fixture';
import { urls } from '../playwright.config';
import { signIn } from './helpers';

test('sign in: an agent reaches their console', async ({ page }) => {
  const w = world();
  await signIn(page, urls.agent, w.a.agent.email);
  await page.goto(`${urls.agent}/my-contacts`);
  await expect(page.getByText(`Cora ${w.tag}`)).toBeVisible();
});

test("a buyer's enquiry on the public site reaches the agent", async ({ page, browser }) => {
  const w = world();
  const email = `buyer.${w.tag}@e2e.test`;
  await page.goto(`${urls.web}/listing/${w.a.liveListingId}`);
  const form = page.locator('form#enquire');
  await form.locator('input[name="name"]').fill(`Bea ${w.tag}`);
  await form.locator('input[name="email"]').fill(email);
  await form.locator('textarea[name="message"]').fill('Is it still available? E2E test.');
  await form.getByRole('button', { name: /send|enquire/i }).click();
  await expect(page.getByRole('heading', { name: 'Enquiry sent' })).toBeVisible();
  const sql = sqlClient();
  const leads = await sql`select agency_id from lead where email = ${email}`.finally(() => sql.end());
  expect(leads.map((l) => l.agency_id)).toEqual([w.a.agencyId]);
  const agent = await browser.newPage();
  await signIn(agent, urls.agent, w.a.agent.email);
  await agent.goto(`${urls.agent}/my-leads`);
  await expect(agent.getByText(`Bea ${w.tag}`).first()).toBeVisible();
});

test('publish a listing: the owner publishes a draft and it is live', async ({ page }) => {
  const w = world();
  // The owner sees every listing of the agency on the agency surface (their own "My Listings" holds only theirs).
  await signIn(page, urls.agency, w.a.owner.email);
  await page.goto(`${urls.agency}/live-listings`);
  const row = page.locator('tr', { hasText: /2 E2E Street/ });
  await row.getByRole('button', { name: /publish/i }).click();
  const sql = sqlClient();
  await expect.poll(async () => (await sql`select status::text as s from listing where id = ${w.a.draftListingId}`)[0]?.s, { timeout: 60_000 }).toBe('live');
  await sql.end();
});

test('an import: a CSV of contacts is checked and added', async ({ page }) => {
  const w = world();
  await signIn(page, urls.agent, w.a.agent.email);
  await page.goto(`${urls.agent}/my-contacts/import`);
  const csv = `name,email,phone,address\nIvy ${w.tag},ivy.${w.tag}@e2e.test,0412 000 111,1 Ivy St Richmond VIC 3121\nIan ${w.tag},ian.${w.tag}@e2e.test,0412 000 222,2 Ian St Richmond VIC 3121\n`;
  await page.locator('input[type="file"]').setInputFiles({ name: `contacts-${w.tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: /upload and match columns/i }).click();
  await page.getByRole('button', { name: /check every row/i }).click();
  await page.getByRole('button', { name: /^add 2 rows/i }).click({ timeout: 120_000 });
  const sql = sqlClient();
  await expect.poll(async () => Number((await sql`select count(*)::int as n from contact where agency_id = ${w.a.agencyId} and email like ${`%.${w.tag}@e2e.test`} and name like 'I%'`)[0]?.n), { timeout: 120_000 }).toBe(2);
  await sql.end();
});

// The assistant needs a model; tests never call a live one (CLAUDE.md). Runs once the target can be given a fake
// model (an env switch the production build refuses), not yet built.
test.fixme('the assistant answers (fake model)', async () => {});
