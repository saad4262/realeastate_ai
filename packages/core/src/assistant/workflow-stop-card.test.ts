import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { changeWorkflowInput } from './schema';
import { runWorkflowAction, verifyWorkflowAction } from './workflow-tools';

/** ADR 0106: the chat's "stop" pauses the workflow AND ends its runs in flight; "pause" only stops new runs. */

const setWorkflowStatus = vi.hoisted(() => vi.fn(async () => undefined));
const stopWorkflowRuns = vi.hoisted(() => vi.fn(async () => ({ stopped: 2 })));
vi.mock('../workflows/manage', async (real) => ({ ...(await real<object>()), setWorkflowStatus, stopWorkflowRuns }));

const actor: Actor = { userId: 'u1', agencyId: 'a1', membershipRole: 'owner' };
const W = '11111111-1111-4111-8111-111111111111';
const tx = {} as Db;

beforeEach(() => vi.clearAllMocks());

describe('change_workflow: stop', () => {
  it('is a change the model may ask for', () => {
    expect(changeWorkflowInput.safeParse({ workflow: 'W1', change: 'stop' }).success).toBe(true);
    expect(changeWorkflowInput.safeParse({ workflow: 'W1', change: 'kill' }).success).toBe(false);
  });

  it('pauses it and stops every run in flight, in the card’s transaction', async () => {
    const out = await runWorkflowAction(tx, actor, { tool: 'change_workflow', workflowId: W, change: 'stop' });
    expect(setWorkflowStatus).toHaveBeenCalledWith(tx, actor, W, 'paused');
    expect(stopWorkflowRuns).toHaveBeenCalledWith(tx, actor, W);
    expect(out.result).toEqual({ workflowId: W, stopped: 2 });
  });

  it('pause leaves the runs in flight alone', async () => {
    await runWorkflowAction(tx, actor, { tool: 'change_workflow', workflowId: W, change: 'pause' });
    expect(setWorkflowStatus).toHaveBeenCalledWith(tx, actor, W, 'paused');
    expect(stopWorkflowRuns).not.toHaveBeenCalled();
  });

  it('is confirmed by the workflow being paused', async () => {
    const read = (status: string) => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status }] }) }) }) }) as unknown as Db;
    expect(await verifyWorkflowAction(read('paused'), { tool: 'change_workflow', change: 'stop' }, { workflowId: W })).toBe(true);
    expect(await verifyWorkflowAction(read('active'), { tool: 'change_workflow', change: 'stop' }, { workflowId: W })).toBe(false);
  });
});
