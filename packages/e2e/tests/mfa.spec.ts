// PLATFORM-PLAN 1.3: MFA with real Supabase TOTP. Runs last (files run in name order): it gives the owner a factor.
import { expect, test } from '@playwright/test';
import { env, PASSWORD, world } from '../fixture';
import { urls } from '../playwright.config';
import { dropFactors, signIn, totp, useSession } from './helpers';

async function auth(path: string, body: unknown, token?: string) {
  const { url, key } = env();
  const res = await fetch(`${url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as { aal?: string };

test('MFA: a wrong code is refused; the right one gives an aal2 session; with MFA enforced, the team page needs it', async ({ page, context }) => {
  const w = world();
  const signedIn = await auth('token?grant_type=password', { email: w.a.owner.email, password: PASSWORD });
  expect(signedIn.status).toBe(200);
  const token = signedIn.json.access_token as string;
  expect(claims(token).aal).toBe('aal1');
  const factor = await auth('factors', { factor_type: 'totp', friendly_name: `e2e-${w.tag}` }, token);
  expect(factor.status).toBe(200);
  const factorId = factor.json.id as string;
  const secret = (factor.json.totp as { secret: string }).secret;
  const challenge = async () => (await auth(`factors/${factorId}/challenge`, {}, token)).json.id as string;

  const wrong = await auth(`factors/${factorId}/verify`, { challenge_id: await challenge(), code: totp(secret) === '000000' ? '111111' : '000000' }, token);
  expect(wrong.status).toBeGreaterThanOrEqual(400);
  expect(wrong.json.access_token).toBeUndefined();

  const right = await auth(`factors/${factorId}/verify`, { challenge_id: await challenge(), code: totp(secret) }, token);
  expect(right.status).toBe(200);
  expect(claims(right.json.access_token as string).aal).toBe('aal2');

  test.skip(process.env.E2E_MFA_ENFORCED !== '1', 'The console must run with MFA_ENFORCED=1 for the page half');
  // aal1: password only. The team page sends an owner without a second factor away.
  await signIn(page, urls.agency, w.a.owner.email);
  await page.goto(`${urls.agency}/team`);
  // Sent to verify a code and come back (refusedForMfa), not away to the overview with no reason.
  await expect(page).toHaveURL(/\/security\?next=(%2F|\/)team$/);
  // The page asks for the code and goes back to the team (a fresh 30-second window: a used code is not taken twice).
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
  await page.locator('#mfa-code').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/team$/);
  // aal2: the verified session in the browser's cookie, as @supabase/ssr writes it (base64url, 3,180-character chunks).
  await context.clearCookies();
  await useSession(context, urls.agency, right.json);
  await page.goto(`${urls.agency}/team`);
  await expect(page).toHaveURL(/\/team/);
});

test('the security page: an agent sets up an app; the next sign-in asks for its code; Sign out of all devices ends the other session', async ({ browser }) => {
  const w = world();
  const SHOTS = process.env.E2E_SHOTS;
  const first = await browser.newContext();
  const a = await first.newPage();
  await signIn(a, urls.agent, w.a.agent.email);
  await a.goto(`${urls.agent}/security`);
  await a.getByRole('button', { name: 'Set up an authenticator app' }).click();
  await expect(a.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  if (SHOTS) await a.screenshot({ path: `${SHOTS}/security-enrol.png`, fullPage: true });
  const secret = (await a.locator('[class*="secret"]').innerText()).trim();
  await a.locator('#mfa-code').fill('000000');
  await a.getByRole('button', { name: 'Verify' }).click();
  await expect(a.getByText('That code did not work')).toBeVisible();
  await a.locator('#mfa-code').fill(totp(secret));
  await a.getByRole('button', { name: 'Verify' }).click();
  await expect(a.getByText('On, with an authenticator app')).toBeVisible();
  if (SHOTS) await a.screenshot({ path: `${SHOTS}/security-on.png`, fullPage: true });

  // A second device: the password alone is not enough any more.
  const second = await browser.newContext();
  const b = await second.newPage();
  await signIn(b, urls.agent, w.a.agent.email);
  await expect(b).toHaveURL(/\/security\?next=/);
  await b.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000);
  await b.locator('#mfa-code').fill(totp(secret));
  await b.getByRole('button', { name: 'Verify' }).click();
  await expect(b).toHaveURL(/\/assistant/);

  // Sign out of all devices, from the second: it lands on sign-in, and the first device's refresh token is dead.
  await b.goto(`${urls.agent}/security`);
  await b.getByRole('button', { name: 'Sign out of all devices' }).click();
  await expect(b).toHaveURL(/\/login/);
  // Signed out in this browser for real: the sign-in form's host-only cookie went too.
  await b.goto(`${urls.agent}/assistant`);
  await expect(b).toHaveURL(/\/login/);
  const chunks = (await first.cookies()).filter((c) => /^sb-[a-z0-9]+-auth-token(\.\d+)?$/.test(c.name)).sort((x, y) => x.name.localeCompare(y.name));
  const held = JSON.parse(Buffer.from(chunks.map((c) => c.value).join('').replace(/^base64-/, ''), 'base64url').toString()) as { refresh_token: string };
  const { url, key } = env();
  const refreshed = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: held.refresh_token }) });
  expect(refreshed.status).toBeGreaterThanOrEqual(400);
  await first.close();
  await second.close();
});

// Later files (and a re-run) sign these people in with a password alone.
test.afterAll(async () => {
  const w = world();
  await dropFactors(w.a.owner.id);
  await dropFactors(w.a.agent.id);
});
