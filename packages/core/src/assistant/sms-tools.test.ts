import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { issueHandle, type HandleMap } from './handles';
import { runAssistantTool, type ToolContext } from './tools';

/** ADR 0088: the Bulk SMS chat's one action, with the batch functions it calls faked. */

const prepareSmsBatch = vi.hoisted(() => vi.fn());
const getBatch = vi.hoisted(() => vi.fn());
const cancelBatch = vi.hoisted(() => vi.fn(async () => undefined));
const propose = vi.hoisted(() => vi.fn(async (_ctx: unknown, label: string, card: unknown) => ({ label, result: { proposed: true, card } })));

vi.mock('../template-email/sms-batches', async (real) => ({ ...(await real<object>()), prepareSmsBatch }));
vi.mock('../template-email/batches', async (real) => ({ ...(await real<object>()), getBatch, cancelBatch }));
vi.mock('./actions', async (real) => ({ ...(await real<object>()), propose }));

const owner: Actor = { userId: 'u1', agencyId: 'a1', membershipRole: 'owner' };

function context(over: Partial<ToolContext> = {}) {
  const handles: HandleMap = {};
  const T = issueHandle(handles, 'T', 'tpl-1');
  const F = issueHandle(handles, 'F', 'list-1');
  const C = issueHandle(handles, 'C', 'contact-1');
  // Both switches on: this file is about the card.
  const db = { select: () => ({ from: () => ({ where: async () => [{ userId: null, enabled: true }, { userId: 'u1', enabled: true }] }) }) } as unknown as Db;
  return { ctx: { db, actor: owner, timeZone: 'UTC', handles, now: new Date('2026-11-09T01:00:00Z'), chatScope: 'bulk_sms', ...over } as ToolContext, T, F, C };
}

const batch = (over: object = {}) => ({
  id: 'b1',
  template: { templateId: 'tpl-1', name: 'Spring', body: 'Hi {{first_name}}' },
  preview: { to: null, subject: '', body: 'Hi Sam' },
  counts: { toSend: 1, skipped: 1 },
  recipients: [
    { contactId: 'contact-1', name: 'Sam', phone: '+61400000000', status: 'queued', skipReason: null },
    { contactId: 'contact-2', name: 'Lee', phone: null, status: 'skipped', skipReason: 'opted_out' },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prepareSmsBatch.mockResolvedValue({ id: 'b1', notFound: 0 });
  getBatch.mockResolvedValue(batch());
});

describe('send_template_sms', () => {
  it('makes a card from the prepared batch, in the SMS channel, frozen on that batch', async () => {
    const { ctx, T, F } = context();
    await runAssistantTool(ctx, 'send_template_sms', { template: T, list: F });
    expect(prepareSmsBatch.mock.calls[0]![2]).toEqual({ templateId: 'tpl-1', filterId: 'list-1' });
    expect(getBatch.mock.calls[0]![4]).toEqual({ channel: 'sms' });
    const sent = propose.mock.calls[0]![2] as { tool: string; args: object; card: { title: string; text: { value: string }; people: { name: string; willReceive: boolean }[] } };
    expect(sent.tool).toBe('send_template_sms');
    expect(sent.args).toEqual({ tool: 'send_template_sms', batchId: 'b1', templateId: 'tpl-1', contactIds: ['contact-1', 'contact-2'] });
    expect(sent.card.title).toContain('1 person');
    expect(sent.card.text.value).toBe('Hi Sam');
    expect(sent.card.people.map((p) => p.willReceive)).toEqual([true, false]);
  });

  it('takes contacts instead of a list, each once', async () => {
    const { ctx, T, C } = context();
    await runAssistantTool(ctx, 'send_template_sms', { template: T, recipients: [C, C] });
    expect(prepareSmsBatch.mock.calls[0]![2]).toEqual({ templateId: 'tpl-1', contactIds: ['contact-1'] });
  });

  it('refuses a reference it never gave out, before preparing anything', async () => {
    const { ctx, F } = context();
    const out = await runAssistantTool(ctx, 'send_template_sms', { template: 'T99', list: F });
    expect(out.isError).toBe(true);
    expect(prepareSmsBatch).not.toHaveBeenCalled();
  });

  it('nobody can receive it: no card, and the empty batch is taken away', async () => {
    getBatch.mockResolvedValue(batch({ counts: { toSend: 0, skipped: 2 } }));
    const { ctx, T, F } = context();
    const out = await runAssistantTool(ctx, 'send_template_sms', { template: T, list: F });
    expect(propose).not.toHaveBeenCalled();
    expect(cancelBatch).toHaveBeenCalled();
    expect(JSON.stringify(out.result)).toContain('nothing was proposed');
  });

  it('a read-only member cannot', async () => {
    const { ctx, T, F } = context({ actor: { userId: 'u1', agencyId: 'a1', membershipRole: 'read_only' } });
    const out = await runAssistantTool(ctx, 'send_template_sms', { template: T, list: F });
    expect(prepareSmsBatch).not.toHaveBeenCalled();
    expect(JSON.stringify(out.result)).toContain('cannot send bulk SMS');
  });

  it('is refused while the pair of switches is not both on', async () => {
    const off = { select: () => ({ from: () => ({ where: async () => [] }) }) } as unknown as Db;
    const { ctx, T, F } = context({ db: off, actor: { userId: 'u1', agencyId: 'a1', membershipRole: 'agent' } });
    const out = await runAssistantTool(ctx, 'send_template_sms', { template: T, list: F });
    expect(JSON.stringify(out.result)).toContain('switched off');
    expect(prepareSmsBatch).not.toHaveBeenCalled();
  });

  it('is refused in a chat from before the ADR', async () => {
    const { ctx, T, F } = context({ chatScope: null });
    const out = await runAssistantTool(ctx, 'send_template_sms', { template: T, list: F });
    expect(out.isError).toBe(true);
    expect(prepareSmsBatch).not.toHaveBeenCalled();
  });
});

describe('approving and cancelling it, read from source', () => {
  const actions = readFileSync(join(__dirname, 'actions.ts'), 'utf8');
  it('uses the screen’s own Approve on the batch it prepared', () => {
    const at = actions.indexOf("case 'send_template_sms': {");
    const branch = actions.slice(at, actions.indexOf('classifySmsRecipients(', at));
    expect(branch).toContain("if ('batchId' in args)");
    expect(branch).toContain('approveSmsBatch(tx, actor, args.batchId, now)');
  });
  it('cannot be set for later, and a rejected card takes its batch with it', () => {
    expect(actions).toMatch(/args\.tool === 'send_template_sms' && 'batchId' in args\) \{\s+throw new AssistantError\('conflict'/);
    expect(actions).toContain("(args.tool === 'send_template_email' || args.tool === 'send_template_sms') && 'batchId' in args");
  });
});
