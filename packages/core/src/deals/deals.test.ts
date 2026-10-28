import { describe, expect, it } from 'vitest';
import { dealStageEnum, type Db } from '@repo/db';
import { DEAL_STAGES, STANDARD_CONDITIONS, stageForListing, stageIndex } from './stages';
import { addConditionSchema, dealDetailsSchema, settleSchema } from './deal-schema';
import { DealError, getDealForListing, listDeals, moveDealStage } from './deals';

/** ADR 0063: the pipeline's fixed parts and its doors. */

const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;
const agencyId = '11111111-1111-1111-1111-111111111111';

describe('the seven stages', () => {
  it('are the database enum, in order', () => {
    expect([...DEAL_STAGES]).toEqual([...dealStageEnum.enumValues]);
    expect(stageIndex('appraisal')).toBe(0);
    expect(stageIndex('settlement')).toBe(6);
  });

  it('come from a listing’s facts, and say nothing for a withdrawn one', () => {
    expect(stageForListing('draft', false)).toBe('listing');
    expect(stageForListing('pending', false)).toBe('listing');
    expect(stageForListing('live', false)).toBe('marketing');
    expect(stageForListing('live', true)).toBe('offers');
    expect(stageForListing('under_offer', true)).toBe('negotiation');
    // "Mark sold" is Contract; Settlement is a separate step (the user, decision 2).
    expect(stageForListing('sold', false)).toBe('contract');
    expect(stageForListing('withdrawn', false)).toBeNull();
  });

  it('give every contract the four standard conditions', () => {
    expect(STANDARD_CONDITIONS.map((c) => c.kind)).toEqual(['cooling_off', 'finance', 'building_pest', 'unconditional']);
  });
});

describe('the Deal tab’s contracts', () => {
  it('take dates as days and prices as dollars, and nothing else', () => {
    expect(dealDetailsSchema.parse({ salePrice: '782000', settlementDate: '2026-12-04' })).toEqual({ salePrice: 782000, settlementDate: '2026-12-04' });
    expect(dealDetailsSchema.safeParse({ settlementDate: '4/12/2026' }).success).toBe(false);
    expect(dealDetailsSchema.safeParse({ stage: 'contract' }).success).toBe(false);
    expect(dealDetailsSchema.safeParse({ salePrice: -1 }).success).toBe(false);
  });
  it('settle with a date, tagging past clients unless asked not to', () => {
    expect(settleSchema.parse({ settledOn: '2026-12-04' })).toEqual({ settledOn: '2026-12-04', tagPastClients: true });
    expect(settleSchema.safeParse({}).success).toBe(false);
  });
  it('add a condition with a name', () => {
    expect(addConditionSchema.safeParse({ label: 'x' }).success).toBe(false);
    expect(addConditionSchema.parse({ label: 'Sale of their home', dueOn: '2026-11-20' })).toEqual({ label: 'Sale of their home', dueOn: '2026-11-20' });
  });
});

describe('the doors', () => {
  it('refuse someone outside an agency before reading anything', async () => {
    await expect(listDeals(noDb, { userId: 'u' })).rejects.toBeInstanceOf(DealError);
    await expect(getDealForListing(noDb, { userId: 'u' }, '22222222-2222-2222-2222-222222222222')).rejects.toBeInstanceOf(DealError);
  });
  it('refuse a deal id that is not an id, before reading anything', async () => {
    await expect(moveDealStage(noDb, { userId: 'u', agencyId, membershipRole: 'agent' }, 'not-an-id', 'contract')).rejects.toThrow(/not found/);
  });
  it('refuse a stage that does not exist', async () => {
    await expect(moveDealStage(noDb, { userId: 'u', agencyId, membershipRole: 'agent' }, 'x', 'sold' as never)).rejects.toThrow();
  });
});

describe('the sync’s SQL', () => {
  it('types every number it sends, so Postgres never guesses (found on the real DB, 2026-10-27)', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { runDealSync } = await import('./sync');
    const seen: string[] = [];
    const dialect = new PgDialect();
    const db = { execute: async (q: Parameters<typeof dialect.sqlToQuery>[0]) => (seen.push(dialect.sqlToQuery(q).sql), []) } as unknown as Db;
    await runDealSync(db);
    const conditions = seen.find((s) => s.includes('insert into deal_condition'))!;
    expect(conditions).toMatch(/\(\$\d+::text, \$\d+::text, \$\d+::int\)/);
    const reminders = seen.find((s) => s.includes('insert into notification'))!;
    expect(reminders.match(/::date \+ \$\d+::int/g)).toHaveLength(2);
  });
});
