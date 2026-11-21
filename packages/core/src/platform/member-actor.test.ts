import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { memberContext } from './member-actor';

/** A Drizzle-shaped fake: every builder call chains, and awaiting the chain is one statement. */
function fakeDb(rows: unknown[]) {
  let statements = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'leftJoin', 'innerJoin', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    statements += 1;
    return Promise.resolve(rows).then(resolve, reject);
  };
  return { db: chain as unknown as Db, count: () => statements };
}

const active = {
  agencyId: 'ag-1', role: 'agent', status: 'active', removedAt: null, agencyStatus: 'active',
  agencyName: 'Acme', agencySlug: 'acme', sendsPausedAt: null, sendsPausedReason: null, userName: 'Sam', links: ['l-1', 'l-2'],
};

describe('memberContext (V1-PERFORMANCE-PLAN steps 3–4)', () => {
  it('is one statement, with the listing links on the actor', async () => {
    const { db, count } = fakeDb([active]);
    const ctx = await memberContext(db, 'u-1');
    expect(count()).toBe(1);
    expect(ctx.actor).toEqual({ userId: 'u-1', agencyId: 'ag-1', membershipRole: 'agent', listingAgentOf: ['l-1', 'l-2'] });
    expect(ctx).toMatchObject({ blocked: null, agencyName: 'Acme', agencySlug: 'acme', userName: 'Sam', sendsPaused: null });
  });

  it('carries the sends pause', async () => {
    const { db } = fakeDb([{ ...active, sendsPausedAt: new Date(), sendsPausedReason: 'spike' }]);
    expect((await memberContext(db, 'u-1')).sendsPaused).toEqual({ reason: 'spike' });
  });

  it('no agency on the actor for a suspended agency, a blocked member, a removed member or no membership', async () => {
    const cases: [unknown[], string | null][] = [
      [[{ ...active, agencyStatus: 'suspended' }], 'agency_suspended'],
      [[{ ...active, status: 'suspended' }], 'member_blocked'],
      [[{ ...active, status: 'suspended', removedAt: new Date() }], null],
      [[], null],
    ];
    for (const [rows, blocked] of cases) {
      const ctx = await memberContext(fakeDb(rows).db, 'u-1');
      expect(ctx.actor).toEqual({ userId: 'u-1' });
      expect(ctx.blocked).toBe(blocked);
      expect(ctx.agencyName).toBeNull();
    }
  });
});
