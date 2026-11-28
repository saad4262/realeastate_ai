import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { createWorkflowInput } from '../assistant/schema';
import { specProblem, WORKFLOW_LIMITS, workflowSpecSchema } from './catalog';
import { stopWorkflowRun, stopWorkflowRuns, WorkflowError } from './manage';

/** ADR 0106: workflows of up to 12 steps, and stopping a run in flight — its owner or an owner/admin only. */

const A = '11111111-1111-4111-8111-111111111111';
const U1 = '22222222-2222-4222-8222-222222222222';
const U2 = '33333333-3333-4333-8333-333333333333';
const BOSS = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const WF = '66666666-6666-4666-8666-666666666666';
const TASK = '77777777-7777-4777-8777-777777777777';
const T = '88888888-8888-4888-8888-888888888888';

const agent = (userId: string): Actor => ({ userId, agencyId: A, membershipRole: 'agent' });
const owner: Actor = { userId: BOSS, agencyId: A, membershipRole: 'owner' };

describe('12 steps (ADR 0106)', () => {
  const remind = { type: 'remind_owner', text: 'x' };
  it('the model’s input takes up to 12 steps, in the workflow and in each AI choice, and refuses 13', () => {
    const input = (actions: unknown[], decide?: unknown) => createWorkflowInput.safeParse({ name: 'W', trigger: { kind: 'lead.created' }, actions, ...(decide ? { decide } : {}) }).success;
    expect(WORKFLOW_LIMITS.actions).toBe(12);
    expect(input(Array(12).fill(remind))).toBe(true);
    expect(input(Array(13).fill(remind))).toBe(false);
    const choices = (n: number) => ({ question: 'Buy or sell?', choices: [{ label: 'Buy', actions: Array(n).fill(remind) }, { label: 'Sell', actions: [remind] }] });
    expect(input([remind], choices(12))).toBe(true);
    expect(input([remind], choices(13))).toBe(false);
  });

  it('the owner’s 11-step new-lead workflow is one valid agency-wide workflow; an agent’s own may not assign', () => {
    const spec = workflowSpecSchema.parse({
      trigger: { kind: 'lead.created' },
      conditions: [],
      actions: [
        { type: 'assign_lead', to: U1 },
        { type: 'message_colleagues', to: [U1], subject: 'New lead', body: 'A new lead is yours' },
        { type: 'set_lead_status', to: 'contacted' },
        { type: 'send_template_email', template_id: T },
        { type: 'wait', hours: 2 },
        { type: 'send_template_sms', template_id: T },
        { type: 'wait', hours: 24 },
        { type: 'set_next_action', text: 'Call {{contact_first_name}}', in_days: 0 },
        { type: 'send_template_email', template_id: T },
        { type: 'wait', hours: 72 },
        { type: 'remind_owner', text: 'No reply after 4 days', mail_me: false },
      ],
    });
    expect(specProblem(spec, 'agency')).toBeNull();
    expect(specProblem(spec, 'mine')).toMatch(/only an agency-wide workflow/);
  });
});

/** Answers each select in turn; the transaction's two updates end `ended` tasks. */
function fakeDb(selects: unknown[][], ended: unknown[] = [{ id: TASK }]) {
  const chain = (rows: unknown[]) => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) });
  const tx = { update: () => ({ set: () => ({ where: () => Object.assign(Promise.resolve([]), { returning: async () => ended }) }) }) };
  const transaction = vi.fn(async (fn: (t: unknown) => unknown) => fn(tx));
  return { db: { select: () => chain(selects.shift() ?? []), transaction } as unknown as Db, transaction };
}

const run = { workflowId: WF, taskId: TASK };
const wf = (ownerId: string, scope: 'mine' | 'agency' = 'mine') => ({ id: WF, agencyId: A, ownerId, scope, status: 'active' });

describe('stopWorkflowRun: who may stop a run (ADR 0106)', () => {
  it('its owner stops their own workflow’s run', async () => {
    const { db, transaction } = fakeDb([[run], [wf(U1)]]);
    expect(await stopWorkflowRun(db, agent(U1), RUN)).toEqual({ stopped: 1 });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('an owner or admin stops an agent’s run', async () => {
    const { db } = fakeDb([[run], [wf(U1)]]);
    expect(await stopWorkflowRun(db, owner, RUN)).toEqual({ stopped: 1 });
  });

  it('another agent may not, and nothing is written', async () => {
    const { db, transaction } = fakeDb([[run], [wf(U1)]]);
    const err = await stopWorkflowRun(db, agent(U2), RUN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(['forbidden', 'not_found']).toContain((err as WorkflowError).code);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('a read-only member may see their own workflow but not stop its run', async () => {
    const { db, transaction } = fakeDb([[run], [wf(U1)]]);
    await expect(stopWorkflowRun(db, { userId: U1, agencyId: A, membershipRole: 'read_only' }, RUN)).rejects.toMatchObject({ code: 'forbidden' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('an agent may not stop an agency-wide workflow’s run', async () => {
    const { db, transaction } = fakeDb([[run], [wf(BOSS, 'agency')]]);
    await expect(stopWorkflowRun(db, agent(U1), RUN)).rejects.toBeInstanceOf(WorkflowError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('a run of another agency, or not an id, is not found', async () => {
    await expect(stopWorkflowRun(fakeDb([[]]).db, owner, RUN)).rejects.toMatchObject({ code: 'not_found' });
    await expect(stopWorkflowRun(fakeDb([]).db, owner, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a run already finished says so', async () => {
    const { db } = fakeDb([[run], [wf(U1)]], []);
    await expect(stopWorkflowRun(db, agent(U1), RUN)).rejects.toMatchObject({ code: 'invalid', message: 'This run has already finished' });
  });
});

describe('stopWorkflowRuns: the chat’s stop, same rule (ADR 0106)', () => {
  it('a read-only member, or a colleague, may not; nothing is read past the workflow', async () => {
    await expect(stopWorkflowRuns(fakeDb([[wf(U1)]]).db, { userId: U1, agencyId: A, membershipRole: 'read_only' }, WF)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(stopWorkflowRuns(fakeDb([[wf(U1)]]).db, agent(U2), WF)).rejects.toBeInstanceOf(WorkflowError);
  });
});
