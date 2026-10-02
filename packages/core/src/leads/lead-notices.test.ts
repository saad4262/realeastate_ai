import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { fakeTransport, type TransactionalMessage } from '../email';
import { notifyLeadAssigned, notifyNewLead, type NoticeDeps } from './lead-notices';

const agencyA = '11111111-1111-1111-1111-111111111111';
const leadId = '33333333-3333-3333-3333-333333333333';
const listingId = '77777777-7777-7777-7777-777777777777';
const agentId = '44444444-4444-4444-4444-444444444444';
const adminId = '66666666-6666-6666-6666-666666666666';

/** Answers each query, in order, from a queue — awaited directly or via `.limit()`. */
function fakeDb(reads: unknown[][]) {
  const queue = [...reads];
  let queries = 0;
  const next = () => {
    queries += 1;
    return Promise.resolve(queue.shift() ?? []);
  };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'leftJoin', 'innerJoin', 'where']) chain[m] = () => chain;
  chain.limit = next;
  chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => next().then(ok, bad);
  return { db: chain as unknown as Db, queries: () => queries };
}

function deps() {
  const transport = fakeTransport();
  const d: NoticeDeps = {
    mailer: {
      sender: { from: { email: 'alerts@example.com', name: 'Test Co' }, postalAddress: '1 Test St' },
      transport,
    },
    urls: { agentUrl: 'http://agents.test', agencyUrl: 'http://agency.test' },
  };
  return { d, sent: () => transport.sent as TransactionalMessage[] };
}

const facts = (over: Record<string, unknown> = {}) => ({
  id: leadId,
  agencyId: agencyA,
  listingId,
  assignedTo: null,
  kind: 'enquiry',
  name: 'Bea Buyer',
  email: 'bea@example.com',
  phone: '0400 000 000',
  message: 'Is the garage double?',
  address: '3/10 Havana Parade, Pakenham',
  ...over,
});

const agent = { userId: agentId, email: 'agent@example.com', name: 'Ali Agent', role: 'agent' };
const admin = { userId: adminId, email: 'boss@example.com', name: 'Sara Boss', role: 'owner' };

describe('notifyNewLead', () => {
  it("mails the listing's agent, with the enquiry in it and a link to their own inbox", async () => {
    const { db } = fakeDb([[facts()], [agent]]);
    const { d, sent } = deps();
    expect(await notifyNewLead(db, d, leadId)).toEqual({ sent: 1, failed: 0 });

    const [m] = sent();
    expect(m!.to.email).toBe('agent@example.com');
    expect(m!.kind).toBe('transactional');
    expect(m!.subject).toBe('New enquiry about 3/10 Havana Parade, Pakenham');
    expect(m!.text).toContain('Is the garage double?');
    expect(m!.text).toContain('bea@example.com');
    expect(m!.text).toContain('http://agents.test/my-leads');
    // Spam Act s.17 — identity in both parts.
    expect(m!.text).toContain('Test Co, 1 Test St');
  });

  it('falls back to the owners and admins when nobody active is on the listing', async () => {
    const { db, queries } = fakeDb([[facts()], [], [admin]]);
    const { d, sent } = deps();
    expect(await notifyNewLead(db, d, leadId)).toEqual({ sent: 1, failed: 0 });
    expect(queries()).toBe(3);
    expect(sent()[0]!.to.email).toBe('boss@example.com');
    // An admin works leads on the agency host.
    expect(sent()[0]!.text).toContain('http://agency.test/leads');
  });

  it('sends nothing for a private offer — those go to owners and admins by their own notice', async () => {
    const { db, queries } = fakeDb([[facts({ kind: 'offer', listingId: null })]]);
    const { d, sent } = deps();
    expect(await notifyNewLead(db, d, leadId)).toEqual({ sent: 0, failed: 0 });
    expect(sent()).toEqual([]);
    expect(queries()).toBe(1);
  });

  it('sends nothing for a lead that does not exist', async () => {
    const { db } = fakeDb([[]]);
    const { d, sent } = deps();
    expect(await notifyNewLead(db, d, leadId)).toEqual({ sent: 0, failed: 0 });
    expect(sent()).toEqual([]);
  });

  it('counts a refused send as failed and carries on to the next person', async () => {
    const { db } = fakeDb([[facts()], [agent, { ...agent, userId: adminId, email: 'co@example.com' }]]);
    const transport = fakeTransport({ fail: { error: 'invalid address', retryable: false } });
    const { d } = deps();
    d.mailer.transport = transport;
    expect(await notifyNewLead(db, d, leadId)).toEqual({ sent: 0, failed: 2 });
  });

  it('escapes what the visitor typed', async () => {
    const { db } = fakeDb([[facts({ message: '<script>x</script>' })], [agent]]);
    const { d, sent } = deps();
    await notifyNewLead(db, d, leadId);
    expect(sent()[0]!.html).not.toContain('<script>');
  });
});

describe('notifyLeadAssigned', () => {
  it('mails the new assignee', async () => {
    const { db } = fakeDb([[facts({ assignedTo: agentId })], [agent]]);
    const { d, sent } = deps();
    expect(await notifyLeadAssigned(db, d, leadId, agentId, adminId)).toEqual({ sent: 1, failed: 0 });
    expect(sent()[0]!.subject).toBe('An enquiry was assigned to you');
    expect(sent()[0]!.text).toContain('http://agents.test/my-leads');
  });

  it('stays quiet when somebody assigns a lead to themselves', async () => {
    const { db, queries } = fakeDb([]);
    const { d, sent } = deps();
    expect(await notifyLeadAssigned(db, d, leadId, adminId, adminId)).toEqual({ sent: 0, failed: 0 });
    expect(queries()).toBe(0);
    expect(sent()).toEqual([]);
  });

  it('stays quiet when the lead moved on before the email went', async () => {
    const { db } = fakeDb([[facts({ assignedTo: adminId })]]);
    const { d, sent } = deps();
    expect(await notifyLeadAssigned(db, d, leadId, agentId, adminId)).toEqual({ sent: 0, failed: 0 });
    expect(sent()).toEqual([]);
  });

  it('never mails an offer to somebody who may not read offers', async () => {
    // assignLead refuses this; a row written by hand must still not leak by email.
    const { db } = fakeDb([[facts({ kind: 'offer', assignedTo: agentId })], [agent]]);
    const { d, sent } = deps();
    expect(await notifyLeadAssigned(db, d, leadId, agentId, adminId)).toEqual({ sent: 0, failed: 0 });
    expect(sent()).toEqual([]);
  });

  it('stays quiet for somebody who is no longer an active member', async () => {
    const { db } = fakeDb([[facts({ assignedTo: agentId })], []]);
    const { d, sent } = deps();
    expect(await notifyLeadAssigned(db, d, leadId, agentId, adminId)).toEqual({ sent: 0, failed: 0 });
    expect(sent()).toEqual([]);
  });
});
