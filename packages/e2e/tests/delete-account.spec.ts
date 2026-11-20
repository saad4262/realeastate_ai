// PLATFORM-PLAN 5.12: a public user deletes their own account from /account/delete; someone at an agency is refused.
import { expect, test } from '@playwright/test';
import { env, PASSWORD, sqlClient, world } from '../fixture';
import { urls } from '../playwright.config';
import { passwordSession, useSession } from './helpers';

async function authAdmin(path: string, init: RequestInit = {}) {
  const { url, key } = env();
  return fetch(`${url}/auth/v1/admin/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
}

test('an agent is refused: they leave through the agency', async ({ page, context }) => {
  const w = world();
  await useSession(context, urls.web, await passwordSession(w.a.agent.email));
  await page.goto(`${urls.web}/account/delete`);
  await page.locator('#confirm-email').fill(w.a.agent.email);
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await expect(page.getByText('This account works at an agency')).toBeVisible();
  const sql = sqlClient();
  try {
    expect((await sql`select 1 from "user" where id = ${w.a.agent.id}`).length).toBe(1);
  } finally {
    await sql.end();
  }
});

test('a buyer deletes their own account: signed out, gone from Auth and from our tables', async ({ page, context }) => {
  const w = world();
  const email = `${w.tag}-buyer@e2e.test`;
  const made = (await (await authAdmin('users', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }) })).json()) as { id: string };
  const sql = sqlClient();
  try {
    await sql`insert into "user" (id, email, name) values (${made.id}, ${email}, 'Buyer') on conflict (id) do nothing`;
    await useSession(context, urls.web, await passwordSession(email));
    await page.goto(`${urls.web}/account/delete`);
    const button = page.getByRole('button', { name: 'Delete my account' });
    await expect(button).toBeDisabled();
    await page.locator('#confirm-email').fill(email);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/delete-account.png`, fullPage: true });
    await button.click();
    await expect(page).toHaveURL(/\/account-deleted$/);
    expect((await sql`select 1 from "user" where id = ${made.id}`).length).toBe(0);
    expect((await authAdmin(`users/${made.id}`)).status).toBe(404);
    await page.goto(`${urls.web}/account`);
    await expect(page).toHaveURL(/\/login/);
  } finally {
    await authAdmin(`users/${made.id}`, { method: 'DELETE' });
    await sql`delete from "user" where id = ${made.id}`;
    await sql.end();
  }
});
