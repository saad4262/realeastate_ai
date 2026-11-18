import { and, eq, isNull, sql } from 'drizzle-orm';
import { agency, aiCreditGrant, stripeEvent, type Db, type DbOrTx } from '@repo/db';
import { enqueueJob, type JobHandler } from '../jobs';
import { can, type Actor } from '../permissions';
import { grantCredits } from './credits';
import { applyPlanToSwitches, planNumbers, topupNumbers, whatIsPrice, type PaidPlan, type Topup } from './plans';
import { verifyStripeSignature, type StripeApi, type StripeSubscription } from './stripe';

/**
 * Billing (ADR 0092, PLATFORM-PLAN 2.4, 2.5, 2.8, 2.11). Each agency has its own Stripe customer, stored on the agency;
 * every event finds its agency by that id, never by metadata, so one agency's payment can never touch another.
 */
export class BillingError extends Error {
  constructor(
    public code: 'forbidden' | 'not_configured' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

export type BillingDeps = { stripe: StripeApi | null; agencyUrl: string; env?: NodeJS.ProcessEnv; now?: () => Date };

function requireOwner(actor: Actor): string {
  const agencyId = actor.agencyId;
  if (!agencyId || !can(actor, 'billing:manage', { type: 'agency', agencyId })) throw new BillingError('forbidden', 'Only the agency’s owner can manage billing.');
  return agencyId;
}

function requireStripe(deps: BillingDeps): StripeApi {
  if (!deps.stripe) throw new BillingError('not_configured', 'Billing is not set up yet.');
  return deps.stripe;
}

/** The agency's Stripe customer, made once (idempotency key per agency; a race keeps the first). */
async function ensureCustomer(db: Db, agencyId: string, stripe: StripeApi): Promise<string> {
  const [a] = await db.select({ customer: agency.stripeCustomerId, name: agency.name }).from(agency).where(eq(agency.id, agencyId)).limit(1);
  if (!a) throw new BillingError('not_found', 'That agency was not found.');
  if (a.customer) return a.customer;
  const made = await stripe.createCustomer({ agencyId, name: a.name, email: null }, `customer:${agencyId}`);
  const [set] = await db.update(agency).set({ stripeCustomerId: made.id, updatedAt: sql`now()` }).where(and(eq(agency.id, agencyId), isNull(agency.stripeCustomerId))).returning({ c: agency.stripeCustomerId });
  if (set?.c) return set.c;
  const [again] = await db.select({ customer: agency.stripeCustomerId }).from(agency).where(eq(agency.id, agencyId)).limit(1);
  return again!.customer!;
}

/** A Checkout page for the owner's own agency: a plan (subscription) or a top-up (one payment). */
export async function startCheckout(db: Db, actor: Actor, choice: { plan: PaidPlan } | { topup: Topup }, deps: BillingDeps): Promise<{ url: string }> {
  const agencyId = requireOwner(actor);
  const stripe = requireStripe(deps);
  const env = deps.env ?? process.env;
  const priceId = 'plan' in choice ? planNumbers(choice.plan, env).stripePriceId : topupNumbers(choice.topup, env).stripePriceId;
  if (!priceId) throw new BillingError('not_configured', 'That plan has no price yet.');
  const customer = await ensureCustomer(db, agencyId, stripe);
  // One session per agency, price and minute: a double click returns the same page, a later visit a fresh one.
  const minute = Math.floor((deps.now ?? (() => new Date()))().getTime() / 60_000);
  const session = await stripe.createCheckoutSession(
    { customer, priceId, mode: 'plan' in choice ? 'subscription' : 'payment', agencyId, successUrl: `${deps.agencyUrl}/billing?done=1`, cancelUrl: `${deps.agencyUrl}/billing` },
    `checkout:${agencyId}:${priceId}:${minute}`,
  );
  return { url: session.url };
}

/** Stripe's Customer Portal for the owner's own agency (change plan, card, invoices, cancel). */
export async function openBillingPortal(db: Db, actor: Actor, deps: BillingDeps): Promise<{ url: string }> {
  const agencyId = requireOwner(actor);
  const stripe = requireStripe(deps);
  const customer = await ensureCustomer(db, agencyId, stripe);
  return stripe.createPortalSession({ customer, returnUrl: `${deps.agencyUrl}/billing` });
}

export const HANDLED_EVENTS = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'charge.refunded',
  'charge.dispute.created',
] as const;

/**
 * The webhook route's whole job: verify, store the event once, enqueue it, and only then answer 200 (a failure
 * to store is a 500, so Stripe retries). The work happens in the `stripe.event` job.
 */
export async function receiveStripeWebhook(db: Db, input: { rawBody: string; signature: string | null }, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): Promise<{ status: number; body: { received?: true; error?: string } }> {
  if (!verifyStripeSignature(input.rawBody, input.signature, env.STRIPE_WEBHOOK_SECRET?.trim(), nowMs)) return { status: 400, body: { error: 'bad signature' } };
  let ev: { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } };
  try {
    ev = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: 'bad body' } };
  }
  const id = typeof ev.id === 'string' ? ev.id : null;
  const type = typeof ev.type === 'string' ? ev.type : null;
  if (!id || !type) return { status: 400, body: { error: 'bad event' } };
  if (!(HANDLED_EVENTS as readonly string[]).includes(type)) return { status: 200, body: { received: true } };
  const o = ev.data?.object ?? {};
  // A dispute's own id is not a charge's; the job needs the charge.
  const objectId = type.startsWith('charge.dispute') ? (typeof o.charge === 'string' ? o.charge : null) : typeof o.id === 'string' ? o.id : null;
  await db.transaction(async (tx) => {
    const [fresh] = await tx.insert(stripeEvent).values({ id, type }).onConflictDoNothing().returning({ id: stripeEvent.id });
    if (fresh) await enqueueJob(tx, { kind: 'stripe.event', lane: 'urgent', dedupeKey: id, payload: { eventId: id, type, objectId } });
  });
  return { status: 200, body: { received: true } };
}

const STATUS: Record<string, 'active' | 'past_due' | 'canceled'> = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled' };

async function agencyOfCustomer(db: DbOrTx, customer: string | null): Promise<{ id: string; plan: string | null; billingStatus: string | null; pastDueSince: Date | null } | null> {
  if (!customer) return null;
  const [a] = await db.select({ id: agency.id, plan: agency.plan, billingStatus: agency.billingStatus, pastDueSince: agency.pastDueSince }).from(agency).where(eq(agency.stripeCustomerId, customer)).limit(1);
  return a ?? null;
}

/** The subscription as Stripe has it now → the agency's plan, billing status and period; switches outside a new plan go off. */
export async function applySubscription(db: Db, sub: StripeSubscription, env: NodeJS.ProcessEnv, now: Date): Promise<void> {
  const a = await agencyOfCustomer(db, sub.customer);
  if (!a) throw new Error(`No agency has Stripe customer ${sub.customer}`);
  const status = STATUS[sub.status];
  if (!status) return; // incomplete: wait for the next event
  const what = whatIsPrice(sub.priceId, env);
  const plan = what && 'plan' in what ? what.plan : null;
  await db.transaction(async (tx) => {
    await tx
      .update(agency)
      .set({
        billingStatus: status,
        currentPeriodEnd: sub.currentPeriodEnd,
        pastDueSince: status === 'past_due' ? (a.pastDueSince ?? now) : null,
        ...(plan && status !== 'canceled' ? { plan } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(agency.id, a.id));
    if (plan && status !== 'canceled' && plan !== a.plan) await applyPlanToSwitches(tx, a.id, plan);
  });
}

/** The `stripe.event` job: fetch the current object from Stripe and set state from it. Order and repeats do not matter. */
export function stripeEventHandler(deps: { stripe: StripeApi | null; env?: NodeJS.ProcessEnv; now?: () => Date }): JobHandler {
  return async (db, j) => {
    if (!deps.stripe) throw new Error('Stripe is not configured');
    const stripe = deps.stripe;
    const env = deps.env ?? process.env;
    const now = (deps.now ?? (() => new Date()))();
    const { type, objectId } = j.payload as { type: string; objectId: string | null };
    if (!objectId) throw new Error(`Stripe event ${type} has no object`);

    if (type.startsWith('customer.subscription.')) return applySubscription(db, await stripe.getSubscription(objectId), env, now);

    if (type === 'invoice.paid') {
      const inv = await stripe.getInvoice(objectId);
      if (inv.status !== 'paid' || !inv.subscription) return;
      const a = await agencyOfCustomer(db, inv.customer);
      if (!a) throw new Error(`No agency has Stripe customer ${inv.customer}`);
      const what = whatIsPrice(inv.priceId, env);
      if (!what || !('plan' in what)) throw new Error(`Invoice ${inv.id} is for a price no plan names`);
      const credits = planNumbers(what.plan, env).credits;
      if (credits === null) throw new Error(`PLAN_${what.plan.toUpperCase()}_CREDITS is not set`);
      await grantCredits(db, { agencyId: a.id, credits, source: 'plan', validFrom: inv.periodStart ?? now, expiresAt: inv.periodEnd ?? new Date(now.getTime() + 31 * 86_400_000), stripeRef: inv.id });
      return;
    }

    if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
      const s = await stripe.getCheckoutSession(objectId);
      // Subscriptions grant on invoice.paid; a payment that confirms later (BECS) grants when it is paid, not before.
      if (s.mode !== 'payment' || s.paymentStatus !== 'paid') return;
      const a = await agencyOfCustomer(db, s.customer);
      if (!a) throw new Error(`No agency has Stripe customer ${s.customer}`);
      const what = whatIsPrice(s.priceId, env);
      if (!what || !('topup' in what) || what.credits === null) throw new Error(`Checkout ${s.id} is for a price no top-up names`);
      await grantCredits(db, { agencyId: a.id, credits: what.credits, source: 'topup', validFrom: now, expiresAt: new Date(now.getTime() + 365 * 86_400_000), stripeRef: s.paymentIntent ?? s.id });
      return;
    }

    if (type === 'charge.refunded' || type === 'charge.dispute.created') {
      const c = await stripe.getCharge(objectId);
      if (!c.paymentIntent) return;
      const a = await agencyOfCustomer(db, c.customer);
      if (!a) throw new Error(`No agency has Stripe customer ${c.customer}`);
      // Take back the unused part, in proportion to what was refunded (all of it for a dispute); never below what was used.
      const share = type === 'charge.dispute.created' || c.amount <= 0 ? 1 : Math.min(1, c.amountRefunded / c.amount);
      await db
        .update(aiCreditGrant)
        .set({ credits: sql`greatest(ceil(${aiCreditGrant.used})::int, ${aiCreditGrant.credits} - floor(${aiCreditGrant.credits} * ${share})::int)` })
        .where(and(eq(aiCreditGrant.agencyId, a.id), eq(aiCreditGrant.stripeRef, c.paymentIntent)));
    }
  };
}
