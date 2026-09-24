import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { isInviteAgentError } from './invite-schema';
import { listAgencyInvites, resendAgentInvite } from './manage-invites';

const agencyA = '11111111-1111-1111-1111-111111111111';
const agencyB = '22222222-2222-2222-2222-222222222222';

const ownerA: Actor = {
  userId: '33333333-3333-3333-3333-333333333333',
  agencyId: agencyA,
  membershipRole: 'owner',
};
const agentA: Actor = {
  userId: '44444444-4444-4444-4444-444444444444',
  agencyId: agencyA,
  membershipRole: 'agent',
};
const strangerB: Actor = {
  userId: '55555555-5555-5555-5555-555555555555',
  agencyId: agencyB,
  membershipRole: 'owner',
};
const noAgency: Actor = { userId: '66666666-6666-6666-6666-666666666666' };

const draft = {
  firstName: 'Daniel',
  lastName: 'Vance',
  displayName: 'Daniel Vance',
  email: 'd.vance@agency.com.au',
  phone: '+61 418 920 441',
  licenceNumber: '2049182',
  territorySuburbs: ['Bondi Beach'],
  operationalRole: 'senior',
  commissionTier: 't1',
};

/** Chained drizzle stand-in; orderBy and limit are the terminals used here. */
function fakeDb(results: unknown[][]) {
  let i = 0;
  const touched: string[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'where', 'update', 'set']) {
    chain[m] = (...args: unknown[]) => {
      touched.push(m);
      void args;
      return chain;
    };
  }
  chain.orderBy = () => Promise.resolve(results[i++] ?? []);
  chain.limit = () => Promise.resolve(results[i++] ?? []);
  // The membership lookup in listAgencyInvites ends on .where, so `where`
  // must be awaitable as well as chainable.
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(results[i++] ?? []).then(res);
  return { db: chain as unknown as Db, touched };
}

const liveRow = {
  id: 'invite-1',
  email: 'd.vance@agency.com.au',
  token: 'tok-1',
  status: 'pending',
  draft,
  expiresAt: new Date(Date.now() + 60 * 60_000),
};

describe('listAgencyInvites permissions', () => {
  it('refuses an agent — managing the roster is not their job', async () => {
    const { db, touched } = fakeDb([[liveRow]]);
    await expect(listAgencyInvites(db, agentA)).rejects.toThrow(/permission/i);
    expect(touched).toEqual([]);
  });

  it('refuses an actor with no agency', async () => {
    const { db, touched } = fakeDb([[liveRow]]);
    await expect(listAgencyInvites(db, noAgency)).rejects.toThrow(/permission/i);
    expect(touched).toEqual([]);
  });

  it('allows the owner and scopes the query to their agency', async () => {
    const { db } = fakeDb([[liveRow], []]);
    const rows = await listAgencyInvites(db, ownerA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'invite-1',
      email: 'd.vance@agency.com.au',
      name: 'Daniel Vance',
      state: 'live',
    });
    expect(rows[0]!.claimPath).toContain('invite=tok-1');
  });

  it('hides accepted invites — those people are already on the roster', async () => {
    const { db } = fakeDb([[{ ...liveRow, status: 'accepted' }], []]);
    await expect(listAgencyInvites(db, ownerA)).resolves.toEqual([]);
  });

  it('keeps lapsed invites visible so a new link can be issued', async () => {
    const { db } = fakeDb([
      [{ ...liveRow, expiresAt: new Date(Date.now() - 60_000) }],
      [],
    ]);
    const rows = await listAgencyInvites(db, ownerA);
    expect(rows[0]?.state).toBe('expired');
  });

  it('drops an invite whose person is already on the roster', async () => {
    const { db } = fakeDb([
      [{ ...liveRow, status: 'expired' }],
      [{ email: liveRow.email.toLowerCase() }],
    ]);
    await expect(listAgencyInvites(db, ownerA)).resolves.toEqual([]);
  });
});

describe('resendAgentInvite permissions', () => {
  it('refuses an agent before reading anything', async () => {
    const { db, touched } = fakeDb([[liveRow]]);
    await expect(resendAgentInvite(db, agentA, 'invite-1')).rejects.toThrow(/permission/i);
    expect(touched).toEqual([]);
  });

  it("refuses another agency's owner", async () => {
    // The query is scoped by agencyId, so a cross-agency id finds nothing.
    const { db } = fakeDb([[]]);
    await expect(resendAgentInvite(db, strangerB, 'invite-1')).rejects.toThrow(
      /no longer exists/i,
    );
  });

  it('rotates the token and pushes the expiry out', async () => {
    // Second result is the membership lookup: nobody with that email yet.
    const { db } = fakeDb([[{ id: 'invite-1', email: liveRow.email, status: 'pending' }], []]);
    const before = Date.now();
    const result = await resendAgentInvite(db, ownerA, 'invite-1');

    expect(result.inviteId).toBe('invite-1');
    expect(result.claimPath).not.toContain('tok-1');
    expect(result.claimPath).toMatch(/invite=[0-9a-f]{48}&/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(before);
  });

  it('will not re-issue a link for someone who already joined', async () => {
    const { db } = fakeDb([[{ id: 'invite-1', email: liveRow.email, status: 'accepted' }]]);
    await expect(resendAgentInvite(db, ownerA, 'invite-1')).rejects.toSatisfy(
      (err: unknown) => isInviteAgentError(err) && err.code === 'already_member',
    );
  });

  it('refuses a lapsed row whose person joined some other way', async () => {
    // They accepted a different invite, so this row still reads 'expired'
    // while the membership already exists. Re-issuing it would hand a live
    // claim link to someone who is on the roster.
    const { db } = fakeDb([
      [{ id: 'invite-1', email: liveRow.email, status: 'expired' }],
      [{ userId: 'someone' }],
    ]);
    await expect(resendAgentInvite(db, ownerA, 'invite-1')).rejects.toSatisfy(
      (err: unknown) => isInviteAgentError(err) && err.code === 'already_member',
    );
  });
});
