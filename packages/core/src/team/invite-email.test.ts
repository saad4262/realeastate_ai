import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { fakeTransport, type TransactionalMessage } from '../email';
import type { Actor } from '../permissions';
import { emailAgentInvite, type InviteEmailDeps } from './invite-email';

const agencyA = '11111111-1111-1111-1111-111111111111';
const inviteId = '22222222-2222-2222-2222-222222222222';
const owner: Actor = { userId: 'o', agencyId: agencyA, membershipRole: 'owner' };
const agent: Actor = { userId: 'a', agencyId: agencyA, membershipRole: 'agent' };

function fakeDb(rows: unknown[]) {
  let queries = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'leftJoin', 'innerJoin', 'where']) chain[m] = () => chain;
  chain.limit = () => {
    queries += 1;
    return Promise.resolve(rows);
  };
  return { db: chain as unknown as Db, queries: () => queries };
}

function deps(fail = false) {
  const transport = fakeTransport(fail ? { fail: { error: 'rejected', retryable: false } } : {});
  const d: InviteEmailDeps = {
    mailer: {
      sender: { from: { email: 'alerts@example.com', name: 'Test Co' }, postalAddress: '1 Test St' },
      transport,
    },
    agentUrl: 'http://agents.test',
  };
  return { d, sent: () => transport.sent as TransactionalMessage[] };
}

const row = {
  email: 'new.agent@example.com',
  status: 'pending',
  draft: { firstName: 'Nadia', lastName: 'Noor', displayName: '' },
  agencyName: 'Pakenham Realty',
  invitedBy: 'Sara Boss',
};
const invite = {
  inviteId,
  claimPath: '/signup?invite=tok123',
  expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
};

describe('emailAgentInvite', () => {
  it('mails the claim link on the agent host to the invited address', async () => {
    const { db } = fakeDb([row]);
    const { d, sent } = deps();
    expect(await emailAgentInvite(db, d, owner, invite)).toEqual({ emailed: true });

    const [m] = sent();
    expect(m!.to).toEqual({ email: 'new.agent@example.com', name: 'Nadia Noor' });
    expect(m!.subject).toBe('Pakenham Realty invited you to join their team');
    expect(m!.text).toContain('http://agents.test/signup?invite=tok123');
    expect(m!.text).toContain('Sara Boss has invited you');
    expect(m!.text).toContain('2 hours');
    expect(m!.text).toContain('Test Co, 1 Test St');
    expect(m!.kind).toBe('transactional');
  });

  it('refuses somebody who cannot manage the team, before reading anything', async () => {
    const { db, queries } = fakeDb([row]);
    const { d, sent } = deps();
    expect((await emailAgentInvite(db, d, agent, invite)).emailed).toBe(false);
    expect(queries()).toBe(0);
    expect(sent()).toEqual([]);
  });

  it('sends nothing for an invite that is gone or no longer pending', async () => {
    for (const rows of [[], [{ ...row, status: 'revoked' }]]) {
      const { db } = fakeDb(rows);
      const { d, sent } = deps();
      expect((await emailAgentInvite(db, d, owner, invite)).emailed).toBe(false);
      expect(sent()).toEqual([]);
    }
  });

  it('reports a refused send as not emailed rather than throwing', async () => {
    const { db } = fakeDb([row]);
    const { d } = deps(true);
    expect((await emailAgentInvite(db, d, owner, invite)).emailed).toBe(false);
  });
});
