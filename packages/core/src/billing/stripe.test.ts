import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { BillingError, receiveStripeWebhook, startCheckout } from './service';
import { verifyStripeSignature, type StripeApi } from './stripe';

/** ADR 0092: the webhook's signature, and who may start a purchase. The event flow is proven on the dev database. */
const SECRET = 'whsec_test';
const NOW = 1_800_000_000_000;
const sign = (body: string, t = NOW / 1000, secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1' } } });

describe('verifyStripeSignature', () => {
  it('accepts Stripe’s signature over the exact body', () => {
    expect(verifyStripeSignature(body, sign(body), SECRET, NOW)).toBe(true);
  });
  it('refuses another secret, a changed body, no header, no secret', () => {
    expect(verifyStripeSignature(body, sign(body, NOW / 1000, 'whsec_other'), SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(body.replace('in_1', 'in_2'), sign(body), SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(body, null, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(body, sign(body), '', NOW)).toBe(false);
  });
  it('refuses a delivery older than 5 minutes (a replay)', () => {
    expect(verifyStripeSignature(body, sign(body, NOW / 1000 - 301), SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(body, sign(body, NOW / 1000 - 299), SECRET, NOW)).toBe(true);
  });
  it('any one valid v1 passes (secret rotation sends two)', () => {
    const header = `${sign(body)},v1=deadbeef`;
    expect(verifyStripeSignature(body, header, SECRET, NOW)).toBe(true);
  });
});

describe('receiveStripeWebhook', () => {
  const env = { STRIPE_WEBHOOK_SECRET: SECRET } as unknown as NodeJS.ProcessEnv;
  const neverDb = { transaction: async () => { throw new Error('must not touch the database'); } } as unknown as Db;
  it('a bad signature is 400 and stores nothing', async () => {
    expect(await receiveStripeWebhook(neverDb, { rawBody: body, signature: sign(body, NOW / 1000, 'x') }, env, NOW)).toMatchObject({ status: 400 });
  });
  it('an event type we do not handle is 200 and stores nothing', async () => {
    const b = JSON.stringify({ id: 'evt_2', type: 'customer.created', data: { object: { id: 'cus_1' } } });
    expect(await receiveStripeWebhook(neverDb, { rawBody: b, signature: sign(b) }, env, NOW)).toMatchObject({ status: 200 });
  });
  it('a failure to store throws (the route answers 500, so Stripe retries)', async () => {
    await expect(receiveStripeWebhook(neverDb, { rawBody: body, signature: sign(body) }, env, NOW)).rejects.toThrow(/must not touch/);
  });
});

describe('startCheckout: owners only, configured prices only', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const stripe = {} as StripeApi;
  const deps = { stripe, agencyUrl: 'https://agency.x', env: {} as NodeJS.ProcessEnv };
  it('an admin, an agent or another agency’s owner may not buy', async () => {
    for (const actor of [
      { userId: 'u', agencyId: A, membershipRole: 'admin' as const },
      { userId: 'u', agencyId: A, membershipRole: 'agent' as const },
    ]) {
      await expect(startCheckout({} as Db, actor, { plan: 'growth' }, deps)).rejects.toMatchObject({ code: 'forbidden' });
    }
  });
  it('a plan with no Stripe Price ID cannot be bought', async () => {
    await expect(startCheckout({} as Db, { userId: 'u', agencyId: A, membershipRole: 'owner' }, { plan: 'growth' }, deps)).rejects.toBeInstanceOf(BillingError);
    await expect(startCheckout({} as Db, { userId: 'u', agencyId: A, membershipRole: 'owner' }, { plan: 'growth' }, deps)).rejects.toMatchObject({ code: 'not_configured' });
  });
  it('without Stripe configured: not configured', async () => {
    await expect(startCheckout({} as Db, { userId: 'u', agencyId: A, membershipRole: 'owner' }, { topup: 'small' }, { ...deps, stripe: null })).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('enqueueBillingReconcile (PLATFORM-PLAN 2.9)', () => {
  it('runs only in its hour; the jobs and their checks are proven on the dev database', async () => {
    const { enqueueBillingReconcile } = await import('./service');
    const untouched = { select: () => { throw new Error('must not read outside its hour'); } } as unknown as Db;
    expect(await enqueueBillingReconcile(untouched, new Date(Date.UTC(2026, 10, 19, 9, 0)))).toBe(0);
  });
});
