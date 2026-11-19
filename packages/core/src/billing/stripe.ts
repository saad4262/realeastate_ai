import { createHmac, timingSafeEqual } from 'node:crypto';
import { call, form, str, type Fetch } from '../integrations/provider-http';

/**
 * Stripe, through its REST API (ADR 0092), the way this codebase talks to every vendor: one small client, `fetch`
 * injected, a fake in tests. Every write carries an idempotency key, so a retried request never makes a second
 * customer or session. Test mode until the owner switches keys.
 */
const API = 'https://api.stripe.com/v1';

export type StripeSubscription = { id: string; customer: string; status: string; priceId: string | null; currentPeriodStart: Date | null; currentPeriodEnd: Date | null };
export type StripeInvoice = { id: string; customer: string; subscription: string | null; status: string; periodStart: Date | null; periodEnd: Date | null; priceId: string | null };
export type StripeCheckoutSession = { id: string; customer: string | null; mode: string; paymentStatus: string; paymentIntent: string | null; priceId: string | null; agencyId: string | null };
export type StripeCharge = { id: string; customer: string | null; paymentIntent: string | null; refunded: boolean; amountRefunded: number; amount: number };

export interface StripeApi {
  createCustomer(input: { agencyId: string; name: string; email: string | null }, idempotencyKey: string): Promise<{ id: string }>;
  createCheckoutSession(
    input: { customer: string; priceId: string; mode: 'subscription' | 'payment'; agencyId: string; successUrl: string; cancelUrl: string },
    idempotencyKey: string,
  ): Promise<{ id: string; url: string }>;
  createPortalSession(input: { customer: string; returnUrl: string }): Promise<{ url: string }>;
  getSubscription(id: string): Promise<StripeSubscription>;
  /** A customer's subscriptions, any status, newest first (the daily reconciliation). */
  listSubscriptions(customer: string): Promise<StripeSubscription[]>;
  getInvoice(id: string): Promise<StripeInvoice>;
  getCheckoutSession(id: string): Promise<StripeCheckoutSession>;
  getCharge(id: string): Promise<StripeCharge>;
}

const secs = (v: unknown): Date | null => (typeof v === 'number' ? new Date(v * 1000) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const idOf = (v: unknown): string | null => (typeof v === 'string' ? v : str(obj(v).id));
const firstPrice = (lines: unknown): string | null => {
  const data = obj(lines).data;
  const first = Array.isArray(data) ? obj(data[0]) : {};
  return idOf(obj(first.price)) ?? idOf(obj(obj(first.pricing).price_details).price) ?? null;
};

function parseSubscription(s: Record<string, unknown>): StripeSubscription {
  const data = obj(s.items).data;
  const item = obj(Array.isArray(data) ? data[0] : {});
  const idOrThrow = (v: string | null, what: string) => {
    if (!v) throw new Error(`Stripe did not return ${what}`);
    return v;
  };
  return {
    id: idOrThrow(str(s.id), 'the subscription'),
    customer: idOrThrow(idOf(s.customer), 'the customer'),
    status: str(s.status) ?? 'incomplete',
    priceId: idOf(obj(item.price)),
    currentPeriodStart: secs(item.current_period_start ?? s.current_period_start),
    currentPeriodEnd: secs(item.current_period_end ?? s.current_period_end),
  };
}

export function stripeClient(secretKey: string, fetchImpl: Fetch = fetch): StripeApi {
  const auth = { authorization: `Bearer ${secretKey}` };
  const get = (path: string) => call(fetchImpl, 'Stripe', `${API}${path}`, { method: 'GET', headers: auth });
  const post = (path: string, body: Record<string, string | undefined>, idempotencyKey?: string) =>
    call(fetchImpl, 'Stripe', `${API}${path}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      body: form(body),
    });
  const need = (v: string | null, what: string) => {
    if (!v) throw new Error(`Stripe did not return ${what}`);
    return v;
  };
  return {
    async createCustomer(input, key) {
      const r = await post('/customers', { name: input.name, email: input.email ?? undefined, 'metadata[agency_id]': input.agencyId }, key);
      return { id: need(str(r.json?.id), 'the customer') };
    },
    async createCheckoutSession(input, key) {
      const r = await post(
        '/checkout/sessions',
        {
          customer: input.customer,
          mode: input.mode,
          'line_items[0][price]': input.priceId,
          'line_items[0][quantity]': '1',
          client_reference_id: input.agencyId,
          'metadata[agency_id]': input.agencyId,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        key,
      );
      return { id: need(str(r.json?.id), 'the session'), url: need(str(r.json?.url), 'the session URL') };
    },
    async createPortalSession(input) {
      const r = await post('/billing_portal/sessions', { customer: input.customer, return_url: input.returnUrl });
      return { url: need(str(r.json?.url), 'the portal URL') };
    },
    async getSubscription(id) {
      return parseSubscription((await get(`/subscriptions/${encodeURIComponent(id)}`)).json ?? {});
    },
    async listSubscriptions(customer) {
      const r = (await get(`/subscriptions?${new URLSearchParams({ customer, status: 'all', limit: '10' })}`)).json ?? {};
      return (Array.isArray(r.data) ? r.data : []).map((s) => parseSubscription(obj(s)));
    },
    async getInvoice(id) {
      const i = (await get(`/invoices/${encodeURIComponent(id)}`)).json ?? {};
      // The subscription line's period is the service period the allowance covers; the invoice's own is a fallback.
      const data = obj(i.lines).data;
      const period = obj(obj(Array.isArray(data) ? data[0] : {}).period);
      return {
        id: need(str(i.id), 'the invoice'),
        customer: need(idOf(i.customer), 'the customer'),
        subscription: idOf(i.subscription) ?? idOf(obj(obj(i.parent).subscription_details).subscription),
        status: str(i.status) ?? '',
        periodStart: secs(period.start ?? i.period_start),
        periodEnd: secs(period.end ?? i.period_end),
        priceId: firstPrice(i.lines),
      };
    },
    async getCheckoutSession(id) {
      const s = (await get(`/checkout/sessions/${encodeURIComponent(id)}?expand[]=line_items`)).json ?? {};
      return {
        id: need(str(s.id), 'the session'),
        customer: idOf(s.customer),
        mode: str(s.mode) ?? '',
        paymentStatus: str(s.payment_status) ?? '',
        paymentIntent: idOf(s.payment_intent),
        priceId: firstPrice(s.line_items),
        agencyId: str(s.client_reference_id) ?? str(obj(s.metadata).agency_id),
      };
    },
    async getCharge(id) {
      const c = (await get(`/charges/${encodeURIComponent(id)}`)).json ?? {};
      return {
        id: need(str(c.id), 'the charge'),
        customer: idOf(c.customer),
        paymentIntent: idOf(c.payment_intent),
        refunded: c.refunded === true,
        amountRefunded: typeof c.amount_refunded === 'number' ? c.amount_refunded : 0,
        amount: typeof c.amount === 'number' ? c.amount : 0,
      };
    },
  };
}

/**
 * Stripe's webhook signature (`Stripe-Signature: t=…,v1=…`): HMAC-SHA256 of `t.rawBody` with the endpoint secret,
 * any v1 matching in constant time, and `t` within the tolerance (5 minutes) so an old delivery cannot be replayed.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string | null | undefined, nowMs: number, toleranceS = 300): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowMs / 1000 - t) > toleranceS) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return sigs.some((s) => {
    const got = Buffer.from(s);
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
