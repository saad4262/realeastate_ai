import { describe, expect, it } from 'vitest';
import type { DbOrTx } from '@repo/db';
import { stepDueAt, verifyExecuted } from './task-state';

/** The read-back (ADR 0040 §4): a step whose result is not really there is undone, never "done". */
function dbReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = () => chain;
  chain.limit = () => Promise.resolve(rows);
  return chain as unknown as DbOrTx;
}

describe('verifyExecuted', () => {
  it('passes when the row the step made is there', async () => {
    await expect(verifyExecuted(dbReturning([{ id: 'n1' }]), { tool: 'add_note', contactId: 'c1' }, { noteId: 'n1' })).resolves.toBeUndefined();
    await expect(verifyExecuted(dbReturning([{ id: 'l1' }]), { tool: 'set_lead_status', leadId: 'l1', status: 'closed' }, {})).resolves.toBeUndefined();
  });
  it('throws when it is not — so the savepoint undoes the step and the card says why', async () => {
    for (const [args, result] of [
      [{ tool: 'add_note', contactId: 'c1' }, { noteId: 'n1' }],
      [{ tool: 'set_lead_status', leadId: 'l1', status: 'closed' }, {}],
      [{ tool: 'assign_lead', leadId: 'l1', to: 'u2' }, {}],
      [{ tool: 'create_lead' }, { leadId: 'l9' }],
      [{ tool: 'remind' }, { notificationId: 'x' }],
      // ADR 0040 part 2: a batch that is not approved, an invite that is not there, a listing that is not.
      [{ tool: 'send_template_email' }, { batchId: 'b1' }],
      [{ tool: 'invite_agent' }, { inviteId: 'i1' }],
      [{ tool: 'withdraw_listing' }, { listingId: 'p1' }],
      [{ tool: 'create_listing_draft' }, {}],
    ] as const) {
      await expect(verifyExecuted(dbReturning([]), args as never, result as never), args.tool).rejects.toThrow(/could not be confirmed/);
    }
  });
  it('trusts tools it has no read-back for (their own core function confirmed them)', async () => {
    await expect(verifyExecuted(dbReturning([]), { tool: 'update_contact' }, {})).resolves.toBeUndefined();
  });
});

describe('stepDueAt — when a released step runs (ADR 0040 part 2 §2)', () => {
  const now = new Date('2026-10-13T10:00:00Z');
  const h = (n: number) => new Date(now.getTime() + n * 3_600_000);
  it('a step with no time and no gap runs now', () => {
    expect(stepDueAt(null, undefined, now)).toEqual(now);
    expect(stepDueAt(h(-1), 0, now)).toEqual(now);
  });
  it('a step keeps its own later time', () => {
    expect(stepDueAt(h(5), undefined, now)).toEqual(h(5));
  });
  it('a later part of a list waits its gap after the part before, however late the plan was approved', () => {
    expect(stepDueAt(null, 24, now)).toEqual(h(24));
    expect(stepDueAt(h(2), 24, now)).toEqual(h(24));
    expect(stepDueAt(h(30), 24, now)).toEqual(h(30));
  });
  it('ignores a gap that is not a positive number', () => {
    for (const gap of [-5, '24', null, Number.NaN]) expect(stepDueAt(null, gap, now), String(gap)).toEqual(now);
  });
});
