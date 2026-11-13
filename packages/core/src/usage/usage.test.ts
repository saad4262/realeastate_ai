import { getTableName, type Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { meter, percentOf, usageFor } from './usage';

/** ADR 0088: what a person is told they have used, without a database. */

const A = '11111111-1111-1111-1111-111111111111';
const owner: Actor = { userId: 'u1', agencyId: A, membershipRole: 'owner' };
const CAPS = { AI_DAILY_BUDGET_USD: '20', ASSISTANT_DAILY_BUDGET_USD_PER_USER: '1', ASSISTANT_DAILY_BUDGET_USD_PER_AGENCY: '10', EMAIL_LIMIT_PER_AGENT_DAY: '50', EMAIL_LIMIT_PER_AGENCY_DAY: '200' } as unknown as NodeJS.ProcessEnv;

/** Answers by table, and counts the statements. */
function tableDb(answers: Record<string, unknown[]>) {
  let queries = 0;
  const db = {
    select: () => {
      let rows: unknown[] = [];
      const chain = {
        from: (t: Table) => ((rows = answers[getTableName(t)] ?? []), chain),
        leftJoin: () => chain,
        where: () => chain,
        limit: () => chain,
        then: (res: (v: unknown) => unknown) => ((queries += 1), Promise.resolve(rows).then(res)),
      };
      return chain;
    },
    // The AI budget's one statement (ai-budget, over ai_run): the fixture's ai_run row, `all` as `total`.
    execute: async () => {
      queries += 1;
      const r = (answers.ai_run?.[0] ?? {}) as { all?: string; person?: string; agency?: string };
      return [{ total: r.all ?? '0', person: r.person ?? '0', agency: r.agency ?? '0' }];
    },
  } as unknown as Db;
  return { db, count: () => queries };
}

const NO_USE = { ai_run: [{ all: '0', person: '0', agency: '0' }], mail_message: [{ agency: '0', agent: '0' }] };

describe('percentOf and meter', () => {
  it('rounds down and stops at 100', () => {
    expect([percentOf(0, 50), percentOf(1, 3), percentOf(49, 50), percentOf(50, 50), percentOf(80, 50)]).toEqual([0, 33, 98, 100, 100]);
  });
  it('a limit of zero is all used', () => {
    expect(percentOf(0, 0)).toBe(100);
  });
  it('is reached at exactly the limit, as the send refuses the next one', () => {
    expect(meter(49, 50).reached).toBe(false);
    expect(meter(50, 50).reached).toBe(true);
  });
});

describe('usageFor', () => {
  it('reads strings from the driver as numbers', async () => {
    const { db } = tableDb({ ai_run: [{ all: '3', person: '0.25', agency: '1' }], mail_message: [{ agency: '30', agent: '12' }] });
    const u = await usageFor(db, owner, { env: CAPS });
    expect(u).toMatchObject({ ai: { percent: 25, allowed: true, message: null }, email: { person: { used: 12, limit: 50, percent: 24 }, agency: { used: 30, limit: 200, percent: 15 } }, sms: null });
  });

  it('shows the larger share of the two AI limits', async () => {
    const { db } = tableDb({ ...NO_USE, ai_run: [{ all: '9', person: '0.1', agency: '9' }] });
    expect((await usageFor(db, owner, { env: CAPS }))!.ai.percent).toBe(90);
  });

  it('never carries a dollar figure', async () => {
    const { db } = tableDb({ ...NO_USE, ai_run: [{ all: '7.77', person: '0.5', agency: '7.77' }] });
    const u = await usageFor(db, owner, { env: CAPS });
    expect(JSON.stringify(u)).not.toMatch(/7\.77|spentUsd|capUsd|remainingUsd/);
  });

  it('says it is stopped when the budget check would stop it, with the same words', async () => {
    const { db } = tableDb({ ...NO_USE, ai_run: [{ all: '1', person: '1', agency: '1' }] });
    const u = await usageFor(db, owner, { env: CAPS });
    expect(u!.ai).toMatchObject({ percent: 100, allowed: false });
    expect(u!.ai.message).toContain('your assistant limit');
  });

  it('is stopped by the platform limit too, which is never shown as a share', async () => {
    const { db } = tableDb({ ...NO_USE, ai_run: [{ all: '20', person: '0', agency: '0' }] });
    expect((await usageFor(db, owner, { env: CAPS }))!.ai).toMatchObject({ percent: 0, allowed: false });
  });

  it('counts texts against the agency’s own setting, or the default', async () => {
    const set = tableDb({ ...NO_USE, phone_number: [{ id: 'n1', perNumber: 40 }], sms_message: [{ n: 10 }] });
    expect((await usageFor(set.db, owner, { env: CAPS }))!.sms).toMatchObject({ used: 10, limit: 40, percent: 25 });
    const unset = tableDb({ ...NO_USE, phone_number: [{ id: 'n1', perNumber: null }], sms_message: [{ n: 10 }] });
    expect((await usageFor(unset.db, owner, { env: CAPS }))!.sms).toMatchObject({ used: 10, limit: 100 });
  });

  it('is a fixed number of statements', async () => {
    const without = tableDb(NO_USE);
    await usageFor(without.db, owner, { env: CAPS });
    expect(without.count()).toBe(3);
    const withNumber = tableDb({ ...NO_USE, phone_number: [{ id: 'n1', perNumber: 40 }], sms_message: [{ n: 1 }] });
    await usageFor(withNumber.db, owner, { env: CAPS });
    expect(withNumber.count()).toBe(4);
  });

  it('asks nothing for someone with no agency, or an admin viewing an agency', async () => {
    const none = tableDb(NO_USE);
    expect(await usageFor(none.db, { userId: 'x' }, { env: CAPS })).toBeNull();
    expect(await usageFor(none.db, { userId: 'x', agencyId: A }, { env: CAPS })).toBeNull();
    expect(await usageFor(none.db, { userId: 'x', agencyId: A, membershipRole: 'owner', via: 'platform' }, { env: CAPS })).toBeNull();
    expect(none.count()).toBe(0);
  });
});
