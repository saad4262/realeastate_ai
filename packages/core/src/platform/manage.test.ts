import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { accessBlock } from './access';
import { blockMember, makeOwner, reactivateAgency, setAgencyPlan, suspendAgency, unblockMember } from './manage';

/**
 * The admin console's controls (ADR 0050). What has to hold:
 *  - only a platform admin (never an owner, never a view) changes anything, and a refusal asks the
 *    database nothing;
 *  - every change writes its platform_action row in the same transaction;
 *  - the guards: a reason for suspending and blocking, not the last owner, not unblocking into a
 *    second active agency;
 *  - accessBlock tells a platform block from an agency's removal.
 */

const A = '11111111-1111-1111-1111-111111111111';
const U = '33333333-3333-3333-3333-333333333333';
const admin: Actor = { userId: '99999999-9999-9999-9999-999999999999', platformAdmin: true };
const owner: Actor = { userId: 'u', agencyId: A, membershipRole: 'owner' };
const view: Actor = { ...owner, via: 'platform', viewerId: admin.userId };

/**
 * A Drizzle fake that answers each awaited statement with the next queued result, and records every
 * update's set() and every insert's values() in order.
 */
function scriptedDb(results: unknown[][]) {
  let i = 0;
  let statements = 0;
  const writes: { kind: 'set' | 'values'; value: Record<string, unknown> }[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'for', 'update', 'insert', 'returning']) {
    chain[m] = () => chain;
  }
  chain.set = (v: Record<string, unknown>) => {
    writes.push({ kind: 'set', value: v });
    return chain;
  };
  chain.values = (v: Record<string, unknown>) => {
    writes.push({ kind: 'values', value: v });
    return chain;
  };
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
    statements += 1;
    return Promise.resolve(results[i++] ?? []).then(res, rej);
  };
  chain.transaction = async (fn: (tx: unknown) => unknown) => fn(chain);
  return { db: chain as unknown as Db, writes, count: () => statements };
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

describe('who may change anything', () => {
  const calls: [string, (db: Db, who: Actor) => Promise<unknown>][] = [
    ['suspendAgency', (db, who) => suspendAgency(db, who, A, 'unpaid invoices')],
    ['reactivateAgency', (db, who) => reactivateAgency(db, who, A, 'active')],
    ['setAgencyPlan', (db, who) => setAgencyPlan(db, who, A, { plan: 'Pro', status: 'active', trialEndsAt: null })],
    ['blockMember', (db, who) => blockMember(db, who, A, U, 'abuse reported')],
    ['unblockMember', (db, who) => unblockMember(db, who, A, U)],
    ['makeOwner', (db, who) => makeOwner(db, who, A, U, { demoteOthers: true })],
  ];
  for (const [name, call] of calls) {
    it(`${name} refuses an agency owner and a platform view, asking the database nothing`, async () => {
      for (const who of [owner, view]) {
        const { db, count } = scriptedDb([]);
        expect(await code(call(db, who))).toBe('forbidden');
        expect(count()).toBe(0);
      }
    });
  }
});

describe('the agency', () => {
  it('suspending sets status, when and why, and records it', async () => {
    const { db, writes } = scriptedDb([[{ id: A, status: 'active', plan: 'Pro', trialEndsAt: null }], [], []]);
    await suspendAgency(db, admin, A, '  unpaid   invoices ');
    expect(writes[0]!.value).toMatchObject({ status: 'suspended', suspendedReason: 'unpaid invoices' });
    expect(writes[1]!.value).toMatchObject({ adminUserId: admin.userId, agencyId: A, action: 'agency_suspended', detail: { from: 'active', reason: 'unpaid invoices' } });
  });

  it('suspending needs a reason, and not twice', async () => {
    expect(await code(suspendAgency(scriptedDb([]).db, admin, A, ' '))).toBe('invalid');
    const { db, writes } = scriptedDb([[{ id: A, status: 'suspended', plan: null, trialEndsAt: null }]]);
    expect(await code(suspendAgency(db, admin, A, 'again'))).toBe('invalid');
    expect(writes).toEqual([]);
  });

  it('reactivating clears the suspension; an agency that is not suspended is refused', async () => {
    const ok = scriptedDb([[{ id: A, status: 'suspended', plan: null, trialEndsAt: null }], [], []]);
    await reactivateAgency(ok.db, admin, A, 'trial');
    expect(ok.writes[0]!.value).toMatchObject({ status: 'trial', suspendedAt: null, suspendedReason: null });
    expect(ok.writes[1]!.value).toMatchObject({ action: 'agency_reactivated', detail: { to: 'trial' } });
    const no = scriptedDb([[{ id: A, status: 'active', plan: null, trialEndsAt: null }]]);
    expect(await code(reactivateAgency(no.db, admin, A, 'active'))).toBe('invalid');
  });

  it('a plan change keeps a suspension, and a trial end only on a trial', async () => {
    const end = new Date('2026-12-01T00:00:00Z');
    const s = scriptedDb([[{ id: A, status: 'suspended', plan: 'trial', trialEndsAt: null }], [], []]);
    await setAgencyPlan(s.db, admin, A, { plan: 'Pro', status: 'active', trialEndsAt: end });
    expect(s.writes[0]!.value).toMatchObject({ plan: 'Pro', status: 'suspended', trialEndsAt: null });
    const t = scriptedDb([[{ id: A, status: 'active', plan: 'Pro', trialEndsAt: null }], [], []]);
    await setAgencyPlan(t.db, admin, A, { plan: 'Trial', status: 'trial', trialEndsAt: end });
    expect(t.writes[0]!.value).toMatchObject({ plan: 'Trial', status: 'trial', trialEndsAt: end });
    expect(t.writes[1]!.value).toMatchObject({ action: 'plan_changed' });
  });

  it('a missing agency or a bad id is not found', async () => {
    expect(await code(suspendAgency(scriptedDb([[]]).db, admin, A, 'reason'))).toBe('not_found');
    expect(await code(suspendAgency(scriptedDb([]).db, admin, 'nope', 'reason'))).toBe('not_found');
  });
});

describe('members', () => {
  it('blocking an active agent suspends the membership without removed_at, and records it', async () => {
    const { db, writes } = scriptedDb([[{ id: 'm', role: 'agent', status: 'active', removedAt: null }], [], []]);
    await blockMember(db, admin, A, U, 'abuse reported');
    expect(writes[0]!.value).toMatchObject({ status: 'suspended' });
    expect(writes[0]!.value).not.toHaveProperty('removedAt');
    expect(writes[1]!.value).toMatchObject({ action: 'member_blocked', subjectUserId: U, detail: { reason: 'abuse reported', role: 'agent' } });
  });

  it('the only owner cannot be blocked; a second owner can', async () => {
    const only = scriptedDb([[{ id: 'm', role: 'owner', status: 'active', removedAt: null }], [{ n: 0 }]]);
    expect(await code(blockMember(only.db, admin, A, U, 'reason'))).toBe('invalid');
    expect(only.writes).toEqual([]);
    const two = scriptedDb([[{ id: 'm', role: 'owner', status: 'active', removedAt: null }], [{ n: 1 }], [], []]);
    expect(await code(blockMember(two.db, admin, A, U, 'reason'))).toBe('ok');
  });

  it('a removed or already blocked member is not blocked again', async () => {
    const removed = scriptedDb([[{ id: 'm', role: 'agent', status: 'suspended', removedAt: new Date() }]]);
    expect(await code(blockMember(removed.db, admin, A, U, 'reason'))).toBe('invalid');
  });

  it('unblocking restores the membership — unless they are active in another agency now, or were removed', async () => {
    const ok = scriptedDb([[{ id: 'm', role: 'agent', status: 'suspended', removedAt: null }], [], [], []]);
    await unblockMember(ok.db, admin, A, U);
    expect(ok.writes[0]!.value).toMatchObject({ status: 'active' });
    expect(ok.writes[1]!.value).toMatchObject({ action: 'member_unblocked', subjectUserId: U });
    const elsewhere = scriptedDb([[{ id: 'm', role: 'agent', status: 'suspended', removedAt: null }], [{ id: 'other' }]]);
    expect(await code(unblockMember(elsewhere.db, admin, A, U))).toBe('invalid');
    const removed = scriptedDb([[{ id: 'm', role: 'agent', status: 'suspended', removedAt: new Date() }]]);
    expect(await code(unblockMember(removed.db, admin, A, U))).toBe('invalid');
  });

  it('making an owner promotes them, demotes the others to admin when asked, and records who', async () => {
    const { db, writes } = scriptedDb([
      [{ id: A, status: 'active', plan: null, trialEndsAt: null }],
      [{ id: 'm', role: 'admin', status: 'active', removedAt: null }],
      [],
      [{ userId: 'old-owner' }],
      [],
    ]);
    await makeOwner(db, admin, A, U, { demoteOthers: true });
    expect(writes[0]!.value).toMatchObject({ role: 'owner' });
    expect(writes[1]!.value).toMatchObject({ role: 'admin' });
    expect(writes[2]!.value).toMatchObject({ action: 'owner_changed', subjectUserId: U, detail: { from: 'admin', demoted: ['old-owner'] } });
  });

  it('only an active member is made owner', async () => {
    const { db } = scriptedDb([[{ id: A, status: 'active', plan: null, trialEndsAt: null }], [{ id: 'm', role: 'agent', status: 'suspended', removedAt: null }]]);
    expect(await code(makeOwner(db, admin, A, U, { demoteOthers: false }))).toBe('invalid');
  });
});

describe('accessBlock', () => {
  it('a platform block, a suspended agency, a removal and an ordinary member', () => {
    expect(accessBlock({ membershipStatus: 'suspended', removedAt: null, agencyStatus: 'active' })).toBe('member_blocked');
    expect(accessBlock({ membershipStatus: 'active', removedAt: null, agencyStatus: 'suspended' })).toBe('agency_suspended');
    // A removal is the agency's decision (ADR 0030), not a block — it keeps its own page.
    expect(accessBlock({ membershipStatus: 'suspended', removedAt: new Date(), agencyStatus: 'active' })).toBeNull();
    expect(accessBlock({ membershipStatus: 'active', removedAt: null, agencyStatus: 'trial' })).toBeNull();
  });
});
