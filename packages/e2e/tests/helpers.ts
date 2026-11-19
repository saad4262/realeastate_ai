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
