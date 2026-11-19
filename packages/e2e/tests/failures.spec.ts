// PLATFORM-PLAN 4.1: the four failures that must fail safely.
import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { sqlClient, world } from '../fixture';
import { urls } from '../playwright.config';
import { signIn } from './helpers';

test("a cross-agency URL is refused: agency B's agent opens A's contact", async ({ page }) => {
  const w = world();
  await signIn(page, urls.agent, w.b.agent.email);
  // A streamed page answers 200 before notFound() renders; what matters is that none of A's contact reaches B.
  await page.goto(`${urls.agent}/my-contacts/${w.a.contactId}`);
  await expect(page.getByText('Not found').first()).toBeVisible();
  await expect(page.getByText(`Cora ${w.tag}`)).toHaveCount(0);
});

test('a duplicate webhook is ignored: the same Stripe event twice is stored and queued once', async ({ request }) => {
  const secret = process.env.E2E_STRIPE_WEBHOOK_SECRET;
  test.skip(!secret, 'E2E_STRIPE_WEBHOOK_SECRET: the target’s test webhook secret');
  const w = world();
  const id = `evt_${w.tag}_dup`;
  const body = JSON.stringify({ id, type: 'invoice.paid', data: { object: { id: `in_${w.tag}` } } });
  for (let i = 0; i < 2; i++) {
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret!).update(`${t}.${body}`).digest('hex');
    const res = await request.post(`${urls.web}/api/stripe/webhook`, { data: body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` } });
    expect(res.status()).toBe(200);
  }
  const sql = sqlClient();
  const [counts] = await sql`select (select count(*)::int from stripe_event where id = ${id}) as events, (select count(*)::int from job where dedupe_key = ${id}) as jobs`.finally(() => sql.end());
  expect(counts).toEqual({ events: 1, jobs: 1 });
});

// Needs Stripe test mode (O-17): a declined card in Checkout, then the agency past due.
test.fixme('a failed payment marks the agency past due, and nothing is held for 7 days', async () => {});

// A wrong MFA code: tests/mfa.spec.ts (PLATFORM-PLAN 1.3).
