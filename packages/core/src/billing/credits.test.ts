import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { checkAiBudget } from '../ai-budget';
import { allocate, creditEstimate, type GrantRow } from './credits';

/** ADR 0092 / PLATFORM-PLAN 2.3. The reservation's atomicity and settlement are proven on the dev database. */
const D = (iso: string) => new Date(iso);
const g = (id: string, source: string, credits: number, used: number, expires: string): GrantRow => ({ id, source, credits, used, expiresAt: D(expires) });

describe('allocate: the allowance first, then the grant that expires soonest', () => {
  const grants = [
    g('topup-late', 'topup', 1000, 0, '2027-11-01T00:00:00Z'),
    g('topup-soon', 'topup', 500, 0, '2027-02-01T00:00:00Z'),
    g('plan', 'plan', 300, 250, '2026-12-01T00:00:00Z'),
  ];
  it('takes what is left of the allowance, then the soonest-expiring top-up', () => {
    expect(allocate(grants, 100)).toEqual({ take: [{ id: 'plan', add: 50 }, { id: 'topup-soon', add: 50 }], overdraft: 0 });
  });
  it('spills across top-ups in expiry order', () => {
    expect(allocate(grants, 800).take).toEqual([{ id: 'plan', add: 50 }, { id: 'topup-soon', add: 500 }, { id: 'topup-late', add: 250 }]);
  });
  it('what no grant covers is overdraft, shown, never lost', () => {
    expect(allocate(grants, 2000).overdraft).toBe(2000 - 50 - 500 - 1000);
    expect(allocate([], 7)).toEqual({ take: [], overdraft: 7 });
  });
  it('fractions of a credit are kept (a cent of model cost is not rounded away)', () => {
    expect(allocate([g('p', 'plan', 10, 0, '2027-01-01T00:00:00Z')], 0.4688).take).toEqual([{ id: 'p', add: 0.4688 }]);
  });
});

describe('creditEstimate', () => {
  it('AI_CREDIT_ESTIMATE, default 5; nonsense falls back', () => {
    expect(creditEstimate({} as NodeJS.ProcessEnv)).toBe(5);
    expect(creditEstimate({ AI_CREDIT_ESTIMATE: '12' } as unknown as NodeJS.ProcessEnv)).toBe(12);
    expect(creditEstimate({ AI_CREDIT_ESTIMATE: '0' } as unknown as NodeJS.ProcessEnv)).toBe(5);
  });
});

describe('checkAiBudget and credits', () => {
  const env = { AI_DAILY_BUDGET_USD: '100' } as unknown as NodeJS.ProcessEnv;
  const row = (plan: string | null) => [{ total: '0', person: '0', agency: '0', public_spend: '0', trial_spend: '0', pool_agency_spend: '0', pool_status: 'active', pool_plan: plan }];
  it('no paid plan (trial, legacy, none): no credit window, no reservation', async () => {
    let transactions = 0;
    const db = { execute: async () => row('trial'), transaction: async () => { transactions++; } } as unknown as Db;
    const r = await checkAiBudget(db, { env, agencyId: 'a1' });
    expect(r).toMatchObject({ allowed: true, credits: null });
    expect(transactions).toBe(0);
  });
  it('a paid plan reserves under a transaction; a refusal says credits', async () => {
    const db = {
      execute: async () => row('growth'),
      transaction: async (fn: (tx: unknown) => unknown) =>
        fn({ execute: async (q: unknown) => (JSON.stringify(q).includes('pg_advisory_xact_lock') ? [] : [{ granted: '3', unsettled: '0', held: '0' }]) }),
    } as unknown as Db;
    const r = await checkAiBudget(db, { env, agencyId: 'a1' });
    expect(r).toMatchObject({ allowed: false, reason: 'credits', credits: { refused: true, balance: 3 } });
  });
});

describe('the billing hold (PLATFORM-PLAN 2.8)', () => {
  it('past due beyond 7 days, or canceled past the paid period; proven per case on the dev database', async () => {
    const { BILLING_HELD, SENDS_HELD_AGENCY_IDS } = await import('../platform/access');
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const held = new PgDialect().sqlToQuery(BILLING_HELD('a')).sql;
    expect(held).toContain("a.billing_status = 'past_due' and a.past_due_since < now() - interval '7 days'");
    expect(held).toContain("a.billing_status = 'canceled' and a.current_period_end < now()");
    expect(new PgDialect().sqlToQuery(SENDS_HELD_AGENCY_IDS).sql).toContain("sa.billing_status = 'past_due'");
  });
});
