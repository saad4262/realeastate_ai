import { describe, expect, it } from 'vitest';
import type { DbOrTx } from '@repo/db';
import { verifyExecuted } from './task-state';

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
    ] as const) {
      await expect(verifyExecuted(dbReturning([]), args as never, result as never), args.tool).rejects.toThrow(/could not be confirmed/);
    }
  });
  it('trusts tools it has no read-back for (their own core function confirmed them)', async () => {
    await expect(verifyExecuted(dbReturning([]), { tool: 'update_contact' }, {})).resolves.toBeUndefined();
  });
});
