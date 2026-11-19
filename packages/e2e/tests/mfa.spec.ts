// PLATFORM-PLAN 1.3: MFA with real Supabase TOTP. Runs last (files run in name order): it gives the owner a factor.
import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { env, PASSWORD, world } from '../fixture';
import { urls } from '../playwright.config';
import { signIn, useSession } from './helpers';

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret: what an authenticator app shows. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

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
  await expect(page).toHaveURL(/\/overview/);
  // aal2: the verified session in the browser's cookie, as @supabase/ssr writes it (base64url, 3,180-character chunks).
  await context.clearCookies();
  await useSession(context, urls.agency, right.json);
  await page.goto(`${urls.agency}/team`);
  await expect(page).toHaveURL(/\/team/);
});
