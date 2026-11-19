// PLATFORM-PLAN 1.22: the admin console signs in again after ADMIN_SESSION_MAX_HOURS (12 by default).
import { expect, test } from '@playwright/test';
import { world } from '../fixture';
import { passwordSession, useSession } from './helpers';

const admin = process.env.E2E_ADMIN ?? 'http://admin.lvh.me:3001';

test('the admin console: a session past its limit is signed out and told why', async ({ page, context }) => {
  test.skip(!process.env.E2E_ADMIN_MAX_HOURS, 'Needs the console running with a tiny ADMIN_SESSION_MAX_HOURS (e.g. 0.005)');
  const w = world();
  // Signed in through Auth's API; middleware's answer is read on a light route (it decides before any page renders).
  await useSession(context, admin, await passwordSession(w.admin.email));
  const live = () => context.request.get(`${admin}/api/live`, { maxRedirects: 0 });
  const inside = await live();
  // Inside the limit: let through (the admin surface sends a stray path on to /platform), never to sign-in.
  expect(inside.headers().location ?? '').not.toMatch(/\/login/);
  // E2E_ADMIN_MAX_HOURS=0.005 is 18 s: past it, the same request is sent to sign in again, and the cookies go.
  await page.waitForTimeout(Number(process.env.E2E_ADMIN_MAX_HOURS) * 3_600_000 + 1_500);
  const past = await live();
  expect(past.status()).toBe(307);
  expect(past.headers().location).toMatch(/\/login\?error=session_expired$/);
  expect(past.headers()['set-cookie'] ?? '').toMatch(/sb-[a-z0-9]+-auth-token=;/);
});
