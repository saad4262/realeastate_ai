# ADR 0092: Plans, AI credits and Stripe billing

Status: accepted for build (PLATFORM-PLAN 2.1, stage 7). Prices are **not** decided here (decision 2).

## Context
Paying agencies need plans, a metered AI allowance and payments, without one agency's billing touching another
and without money drifting from Stripe. PLATFORM-PLAN section 13 proposes three plans with credits; the reviews
added atomic credits (2.3), billing isolation (2.11), out-of-order and async Stripe events (2.5), billing states
(2.8), reconciliation (2.9) and seat limits (2.10).

## Decisions
1. **A credit is US$0.01 of model cost**, read from `ai_run.cost_usd`. Credits, not tokens: model prices differ.
2. **The plan map lives in code** (`packages/core/src/billing/plans.ts`): plan → skills it allows. Its numbers —
   credits a month, seats, the Stripe Price ID — come from env (`PLAN_<NAME>_CREDITS`, `PLAN_<NAME>_SEATS`,
   `STRIPE_PRICE_<NAME>`). No price or allowance is written in code; section 13's figures are a proposal until the
   owner decides. A plan with no Price ID configured cannot be bought. `can()` refuses a skill outside the plan.
3. **The allowance is spent first, then top-ups.** The allowance resets on the billing date and does not roll over.
   Top-ups are grants (`ai_credit_grant`: agency, credits, source `plan|topup|admin`, valid from, expires,
   Stripe reference unique) that last 12 months, spent oldest first.
4. **Credits are reserved atomically.** Before a model call: one transaction takes a per-agency advisory lock
   (`pg_advisory_xact_lock`), reads the balance (grants − settled spend − open holds), refuses when the call's
   estimate does not fit, else writes an `ai_credit_hold`. `usage.ts` settles the hold with the real cost when it
   writes `ai_run`; a hold not settled within 15 minutes expires. Parallel calls queue on the agency's lock only;
   other agencies are not slowed. The platform and pool caps (ADR 0086, PLATFORM-PLAN 1.24) still apply.
5. **One Stripe customer per agency** (`agency.stripe_customer_id`, unique). Checkout and Customer Portal sessions
   are made on the server for the actor's own agency, owners only (`billing:manage`, MFA required by 1.22).
6. **Webhooks**: the signature is verified, the event id stored once (`stripe_event`, unique), a `stripe.event`
   job enqueued (deduped by event id), and only then 200 (PLATFORM-PLAN 3.2). The job fetches the **current**
   object from Stripe and sets state from it, keyed by our stored customer id (never by metadata alone), so order
   and duplicates do not matter. Every Stripe API call carries an idempotency key.
7. **Payments that confirm later** (BECS direct debit): credits are granted on `invoice.paid` /
   `checkout.session.async_payment_succeeded`, never on session completion alone. Refunds and disputes take back
   the unused part of the grant they paid for.
8. **Billing states on the agency**: `trial → active → past_due → canceled`. Past due: 7 days' grace with emails,
   then AI and sends stop for that agency only (the held set of PLATFORM-PLAN 3.7 gains the billing hold); the data
   stays. Canceled: runs to the period's end, then the 30-day deletion (decision 4).
9. **Daily reconciliation**: each agency's plan, status and grants are compared with Stripe's subscription and paid
   invoices; a mismatch alerts the platform admin and is listed; nothing is auto-corrected.
10. **Seats** are checked in the invite claim's transaction with the agency row locked (PLATFORM-PLAN 2.10).
11. **Test mode only** (`sk_test_…`, Preview and dev) until the owner decides prices and switches keys. Tax
    invoices with GST via Stripe Tax, confirmed by the accountant.

## Consequences
- Billing state changes are jobs, retried and dead-lettered like the rest (ADR for the queue: PLATFORM-PLAN 3.1).
- A Stripe outage delays grants and state, never double-grants; reconciliation catches what a lost event missed.
- New tables: `ai_credit_grant`, `ai_credit_hold`, `stripe_event`; new agency columns: `stripe_customer_id`,
  `billing_status`, `current_period_end`, `past_due_since`. All agency-scoped tables enter the isolation matrix.
