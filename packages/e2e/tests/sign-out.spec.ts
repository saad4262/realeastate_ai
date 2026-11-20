// PLATFORM-PLAN 1.22: Sign out leaves this browser signed out even when it holds the session cookie twice — host-only
// (the sign-in form's browser client) and under COOKIE_DOMAIN (middleware's refresh). Next used to emit one deletion.
import { expect, test } from '@playwright/test';
import { env, world } from '../fixture';
import { urls } from '../playwright.config';
import { passwordSession, signIn } from './helpers';

test('Sign out with the session cookie held host-only and under the cookie domain: signed out for real', async ({ page, context }) => {
  const w = world();
  await signIn(page, urls.agent, w.a.agent.email);
  // A second copy under the shared domain, as middleware writes it when it refreshes the session.
  const ref = new URL(env().url).hostname.split('.')[0]!;
  const value = `base64-${Buffer.from(JSON.stringify(await passwordSession(w.a.agent.email))).toString('base64url')}`;
  const domain = `.${new URL(urls.agent).hostname.split('.').slice(1).join('.')}`;
  await context.addCookies([{ name: `sb-${ref}-auth-token`, value, domain, path: '/', sameSite: 'Lax' }]);
  expect((await context.cookies()).filter((c) => c.name.startsWith('sb-')).length).toBe(2);

  await page.goto(`${urls.agent}/assistant`, { waitUntil: 'networkidle' });
  const sidebar = page.locator('#console-sidebar');
  await sidebar.getByRole('button', { name: 'Settings' }).click();
  await sidebar.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
  expect((await context.cookies()).filter((c) => c.name.startsWith('sb-') && c.value)).toEqual([]);
  await page.goto(`${urls.agent}/assistant`);
  await expect(page).toHaveURL(/\/login/);
});
