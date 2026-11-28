import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { HandleMap } from './handles';
import { runAssistantTool, type ToolContext } from './tools';

/** 2026-11-28 browser run (DC7): the Email chat listed its email templates when the model asked for SMS ones, without saying so. */

const listTemplates = vi.hoisted(() => vi.fn(async () => ({ templates: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Welcome', subject: 'Hi', mayUse: true }], mayDraft: true })));
vi.mock('../template-email/templates', async (real) => ({ ...(await real<object>()), listTemplates }));

const ctx = (chatScope: string | null) => ({ env: undefined, db: {} as Db, actor: { userId: 'u1', agencyId: 'a1', membershipRole: 'owner' }, timeZone: 'Australia/Sydney', handles: {} as HandleMap, now: new Date(), chatScope, skillsOff: async () => new Set() }) as unknown as ToolContext;

describe('list_templates says which channel it listed', () => {
  it('the Email chat asked for SMS: email templates, labelled, and that none is an SMS one', async () => {
    const out = await runAssistantTool(ctx('email'), 'list_templates', { channel: 'sms' });
    expect(listTemplates).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { channel: 'email' });
    expect(out.result).toMatchObject({ channel: 'email', not_listed: 'This chat lists only email templates. SMS templates are not shown here, so none of these is one.' });
  });
  it('Overview lists what was asked, with no warning', async () => {
    const out = await runAssistantTool(ctx('general'), 'list_templates', { channel: 'sms' });
    expect(listTemplates).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { channel: 'sms' });
    expect(out.result).toMatchObject({ channel: 'sms' });
    expect(out.result).not.toHaveProperty('not_listed');
  });
});
