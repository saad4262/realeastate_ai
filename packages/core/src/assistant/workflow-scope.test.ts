import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import { issueHandle, type HandleMap } from './handles';
import type { ToolContext } from './tools';
import { findWorkflows, proposeChangeWorkflow, proposeCreateWorkflow } from './workflow-tools';

/** ADR 0088: an automations chat and the workflows already stored, whose steps the input cannot show. */

const listWorkflows = vi.hoisted(() => vi.fn());
vi.mock('../workflows/manage', async (real) => ({ ...(await real<object>()), listWorkflows }));

const wf = (id: string, stepTypes: string[]) => ({ id, name: id, status: 'active', pausedReason: null, scope: 'mine', mine: true, ownerName: 'Sam', words: { when: '', if: [], then: [] }, runsToday: 0, mayManage: true, stepTypes });

function ctx(chatScope: ToolContext['chatScope']) {
  const handles: HandleMap = {};
  return { c: { db: {} as Db, actor: { userId: 'u1', agencyId: 'a1', membershipRole: 'owner' }, timeZone: 'UTC', handles, now: new Date(), chatScope } as ToolContext, handles };
}

beforeEach(() => {
  listWorkflows.mockResolvedValue([wf('email', ['send_template_email']), wf('sms', ['send_template_sms']), wf('both', ['send_template_email', 'send_template_sms']), wf('note', ['add_note'])]);
});

const shown = async (scope: ToolContext['chatScope']) => ((await findWorkflows(ctx(scope).c, 'x')).result as { workflows: { name: string }[] }).workflows.map((w) => w.name);

describe('find_workflows', () => {
  it('shows each chat only what it can change', async () => {
    expect(await shown('email_automations')).toEqual(['email', 'note']);
    expect(await shown('sms_automations')).toEqual(['sms', 'note']);
  });
  it('a chat from before the ADR still sees them all', async () => {
    expect(await shown(null)).toEqual(['email', 'sms', 'both', 'note']);
  });
});

describe('a stored workflow from the other channel', () => {
  const change = (scope: ToolContext['chatScope'], id: string) => {
    const { c, handles } = ctx(scope);
    const ref = issueHandle(handles, 'W', id);
    return proposeChangeWorkflow(c, { workflow: ref, change: 'pause' }, 'x');
  };
  it('cannot be paused or archived here, even by a reference from elsewhere', async () => {
    for (const id of ['sms', 'both']) expect(JSON.stringify((await change('email_automations', id)).result), id).toContain('other channel');
    expect(JSON.stringify((await change('sms_automations', 'email')).result)).toContain('other channel');
  });
  it('cannot be replaced here', async () => {
    const { c, handles } = ctx('email_automations');
    const ref = issueHandle(handles, 'W', 'both');
    const out = await proposeCreateWorkflow(c, { name: 'x', scope: 'mine', trigger: { kind: 'lead.created' }, conditions: [], actions: [{ type: 'add_note', text: 'x' }], replaces: ref } as never, 'x');
    expect(JSON.stringify(out.result)).toContain('other channel');
  });
});
