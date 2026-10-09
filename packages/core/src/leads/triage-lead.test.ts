import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import type { Actor } from '../permissions';
import { assignLead, LeadTriageError, updateLeadStatus } from './triage-lead';

const agencyA = '11111111-1111-1111-1111-111111111111';
const leadId = '33333333-3333-3333-3333-333333333333';
const agentId = '44444444-4444-4444-4444-444444444444';
const otherAgentId = '55555555-5555-5555-5555-555555555555';
const ownerId = '66666666-6666-6666-6666-666666666666';
const listingId = '77777777-7777-7777-7777-777777777777';

const owner: Actor = { userId: ownerId, agencyId: agencyA, membershipRole: 'owner' };
const agent: Actor = { userId: agentId, agencyId: agencyA, membershipRole: 'agent' };

/**
 * Answers reads (`.limit()`) and writes (`.returning()`) from two queues, and
 * records every SET and rendered WHERE — so a test can prove a refused call
 * wrote nothing, and that a permitted one wrote only what it should, scoped
 * the way it should.
 */
function fakeDb(opts: { reads?: unknown[][]; returns?: unknown[][] } = {}) {
  const reads = [...(opts.reads ?? [])];
  const returns = [...(opts.returns ?? [])];
  const sets: Record<string, unknown>[] = [];
  const wheres: string[] = [];
  const dialect = new PgDialect();
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'update']) chain[m] = () => chain;
  chain.set = (v: Record<string, unknown>) => {
    sets.push(v);
    return chain;
  };
  chain.where = (clause: SQL) => {
    wheres.push(dialect.sqlToQuery(clause).sql);
    return chain;
  };
  chain.limit = () => Promise.resolve(reads.shift() ?? []);
  chain.returning = () => Promise.resolve(returns.shift() ?? []);
  // A reassignment writes its handover and timeline in the same transaction; the fake is its own.
  const inserts: Record<string, unknown>[] = [];
  chain.transaction = (fn: (tx: unknown) => unknown) => fn(chain);
  chain.insert = () => chain;
  chain.values = (v: Record<string, unknown>) => {
    inserts.push(v);
    return Promise.resolve();
  };
  return { db: chain as unknown as DbOrTx, sets, wheres, inserts };
}

const enquiry = (assignedTo: string | null = null) => ({
  id: leadId,
  agencyId: agencyA,
  kind: 'enquiry',
  assignedTo,
  listingId: null as string | null,
});
const offer = (assignedTo: string | null = null) => ({ ...enquiry(assignedTo), kind: 'offer' });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof LeadTriageError ? err.code : `threw ${String(err)}`;
  }
}

describe('updateLeadStatus', () => {
  it('reads the lead inside the actor agency only, so another tenant gets not_found', async () => {
    const { db, sets, wheres } = fakeDb({ reads: [[]] });
    expect(await code(updateLeadStatus(db, owner, leadId, 'contacted'))).toBe('not_found');
    expect(wheres[0]).toMatch(/"agency_id" = \$/);
    expect(sets).toEqual([]);
  });

  it('refuses a malformed id and a status outside the enum before touching the database', async () => {
    const a = fakeDb();
    expect(await code(updateLeadStatus(a.db, owner, 'not-a-uuid', 'contacted'))).toBe('not_found');
    expect(a.wheres).toEqual([]);
    const b = fakeDb();
    expect(await code(updateLeadStatus(b.db, owner, leadId, 'archived'))).toBe('invalid');
    expect(b.wheres).toEqual([]);
  });

  it('lets an admin move an unassigned lead', async () => {
    const { db, sets } = fakeDb({
      reads: [[enquiry()]],
      returns: [[{ id: leadId, status: 'contacted', assignedTo: null }]],
    });
    await expect(updateLeadStatus(db, owner, leadId, 'contacted')).resolves.toMatchObject({
      status: 'contacted',
    });
    expect(sets[0]).toMatchObject({ status: 'contacted' });
  });

  it("treats another agent's lead as not found, and writes nothing", async () => {
    // Not assigned to them and not from their listing: they cannot see it, so
    // they cannot learn it exists (ADR 0014).
    for (const assigned of [null, otherAgentId]) {
      const { db, sets } = fakeDb({ reads: [[enquiry(assigned)]] });
      expect(await code(updateLeadStatus(db, agent, leadId, 'closed'))).toBe('not_found');
      expect(sets).toEqual([]);
    }
  });

  it("being the listing's agent opens nothing: an unassigned lead, or one given to someone else, is not found", async () => {
    // The client's rule (2026-10-07): a lead is its assignee's alone; unassigned ones are an admin's.
    const named: Actor = { ...agent, listingAgentOf: [listingId] };
    const unassigned = fakeDb({ reads: [[{ ...enquiry(), listingId }]] });
    expect(await code(updateLeadStatus(unassigned.db, named, leadId, 'contacted'))).toBe('not_found');
    expect(unassigned.sets).toEqual([]);
    const taken = fakeDb({ reads: [[{ ...enquiry(otherAgentId), listingId }]] });
    expect(await code(updateLeadStatus(taken.db, named, leadId, 'closed'))).toBe('not_found');
    expect(taken.sets).toEqual([]);
  });

  it('lets the assigned agent move it, but only while it is still theirs', async () => {
    const { db, wheres } = fakeDb({
      reads: [[enquiry(agentId)]],
      returns: [[{ id: leadId, status: 'qualified', assignedTo: agentId }]],
    });
    await expect(updateLeadStatus(db, agent, leadId, 'qualified')).resolves.toMatchObject({
      status: 'qualified',
    });
    // The assignment the decision rested on is in the UPDATE's WHERE.
    expect(wheres[1]).toMatch(/"assigned_to" = \$/);
  });

  it('reports a reassignment that raced the write as a conflict', async () => {
    const { db } = fakeDb({ reads: [[enquiry(agentId)]], returns: [[]] });
    expect(await code(updateLeadStatus(db, agent, leadId, 'closed'))).toBe('conflict');
  });

  it('treats an offer the actor may not read as a lead that does not exist', async () => {
    // Even assigned to them — which assignLead refuses, but a row written
    // before that rule, or by hand, must still not leak.
    const { db, sets } = fakeDb({ reads: [[offer(agentId)]] });
    expect(await code(updateLeadStatus(db, agent, leadId, 'contacted'))).toBe('not_found');
    expect(sets).toEqual([]);
  });
});

describe('assignLead', () => {
  it('refuses anybody who does not run the agency', async () => {
    const { db, sets } = fakeDb({ reads: [[enquiry(agentId)]] });
    expect(await code(assignLead(db, agent, leadId, otherAgentId))).toBe('forbidden');
    expect(sets).toEqual([]);
  });

  it('refuses a person who is not an active member of this agency', async () => {
    const { db, sets } = fakeDb({ reads: [[enquiry()], []] });
    expect(await code(assignLead(db, owner, leadId, otherAgentId))).toBe('invalid');
    expect(sets).toEqual([]);
  });

  it('will not hand a private offer to someone who cannot see offers', async () => {
    const { db, sets } = fakeDb({ reads: [[offer()], [{ role: 'agent' }]] });
    expect(await code(assignLead(db, owner, leadId, agentId))).toBe('invalid');
    expect(sets).toEqual([]);
  });

  it('assigns an enquiry to an agent, and repeats the membership check in the write', async () => {
    const { db, sets, wheres } = fakeDb({
      reads: [[enquiry()], [{ role: 'agent' }]],
      returns: [[{ id: leadId, status: 'new', assignedTo: agentId }]],
    });
    await expect(assignLead(db, owner, leadId, agentId)).resolves.toMatchObject({
      assignedTo: agentId,
    });
    expect(sets[0]).toMatchObject({ assignedTo: agentId });
    expect(wheres.at(-1)).toMatch(/exists \(\s*select 1 from "membership"/);
  });

  it('assigns an offer to an admin, and takes a lead back with null', async () => {
    const a = fakeDb({
      reads: [[offer()], [{ role: 'admin' }]],
      returns: [[{ id: leadId, status: 'new', assignedTo: ownerId }]],
    });
    await expect(assignLead(a.db, owner, leadId, ownerId)).resolves.toMatchObject({
      assignedTo: ownerId,
    });

    const b = fakeDb({
      reads: [[enquiry(agentId)]],
      returns: [[{ id: leadId, status: 'new', assignedTo: null }]],
    });
    await expect(assignLead(b.db, owner, leadId, null)).resolves.toMatchObject({
      assignedTo: null,
    });
    expect(b.sets[0]).toEqual(expect.objectContaining({ assignedTo: null }));
  });

  it('from the assistant: refuses a lead that changed hands since the card showed who had it — and guards the write too', async () => {
    const moved = fakeDb({ reads: [[enquiry(otherAgentId)], [{ role: 'agent' }]] });
    expect(await code(assignLead(moved.db, owner, leadId, agentId, { via: 'assistant', expectedFrom: null }))).toBe('conflict');
    expect(moved.sets).toEqual([]);

    const same = fakeDb({
      reads: [[enquiry(otherAgentId)], [{ role: 'agent' }]],
      returns: [[{ id: leadId, status: 'new', assignedTo: otherAgentId }]],
    });
    await assignLead(same.db, owner, leadId, agentId, { via: 'assistant', expectedFrom: otherAgentId });
    expect(same.wheres.at(-1)).toMatch(/"assigned_to" is not distinct from \$/);
  });

  it('reports a member removed between the check and the write as a conflict', async () => {
    const { db } = fakeDb({ reads: [[enquiry()], [{ role: 'agent' }]], returns: [[]] });
    expect(await code(assignLead(db, owner, leadId, agentId))).toBe('conflict');
  });
});
