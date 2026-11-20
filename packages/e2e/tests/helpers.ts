import { createHmac } from 'node:crypto';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { env, PASSWORD } from '../fixture';

export async function signIn(page: Page, base: string, email: string) {
  await page.goto(`${base}/login`);
  await page.locator('#agency-email').fill(email);
  await page.locator('#agency-password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 90_000 });
}

/** A Supabase session put into the browser the way @supabase/ssr writes it (base64url, 3,180-character chunks). */
export async function useSession(context: BrowserContext, baseUrl: string, session: Record<string, unknown>) {
  const ref = new URL(env().url).hostname.split('.')[0]!;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
  const chunks = value.match(/.{1,3180}/g)!;
  const domain = new URL(baseUrl).hostname;
  await context.addCookies(
    chunks.map((v, i) => ({ name: chunks.length === 1 ? `sb-${ref}-auth-token` : `sb-${ref}-auth-token.${i}`, value: v, domain, path: '/', sameSite: 'Lax' as const })),
  );
}

/** A password sign-in through Auth's API: the session object a browser would hold. */
export async function passwordSession(email: string): Promise<Record<string, unknown>> {
  const { url, key } = env();
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (!res.ok) throw new Error(`sign-in ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret: what an authenticator app shows. */
export function totp(secret: string, at = Date.now()): string {
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

/** Removes every MFA factor a test gave this person, so later files sign in with a password alone. */
export async function dropFactors(userId: string) {
  const { url, key } = env();
  const headers = { apikey: key, authorization: `Bearer ${key}` };
  const u = (await (await fetch(`${url}/auth/v1/admin/users/${userId}`, { headers })).json()) as { factors?: { id: string }[] };
  for (const f of u.factors ?? []) await fetch(`${url}/auth/v1/admin/users/${userId}/factors/${f.id}`, { method: 'DELETE', headers });
}
