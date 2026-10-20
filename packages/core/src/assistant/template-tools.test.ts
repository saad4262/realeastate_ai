import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOL_INPUTS, PLANNABLE_TOOLS, PROPOSED_ACTION_TOOLS } from './schema';
import { proposeCreateTemplate, templateCard } from './template-tools';
import type { ToolContext } from './tools';

/** ADR 0048: a template written in the chat — the exact words on the card, nothing saved or sent before Approve. */

const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as never;
const ctx = (membershipRole: string): ToolContext => ({ db: noDb, actor: { userId: 'u', agencyId: 'a', membershipRole } as never, timeZone: 'Australia/Sydney', handles: {}, now: new Date() });
const input = { name: 'Welcome', subject: 'Thanks {{first_name}}', body: 'Hi {{first_name}}, the open home is Saturday at 10:30am.\n{{agent_name}}' };

describe('create_template', () => {
  it('is a card (a proposed_action tool), never a plan step', () => {
    expect(PROPOSED_ACTION_TOOLS as readonly string[]).toContain('create_template');
    expect(PLANNABLE_TOOLS as readonly string[]).not.toContain('create_template');
    expect(ASSISTANT_TOOL_INPUTS.create_template.safeParse({ ...input, to: 'a@b.co' }).success).toBe(false);
  });

  it('refused before the database for someone who may not write templates, or a merge field that does not exist', async () => {
    const ro = await proposeCreateTemplate(ctx('read_only'), input, 'x');
    expect(ro).toMatchObject({ isError: true, result: { error: expect.stringMatching(/may not write email templates/) } });
    const bad = await proposeCreateTemplate(ctx('agent'), { ...input, body: 'Hi {{suburb}}' }, 'x');
    expect(bad).toMatchObject({ isError: true, result: { error: expect.stringMatching(/Unknown merge field: suburb/) } });
  });

  it('the card shows the exact words, every figure, who it is for, and that nothing is sent', () => {
    const card = templateCard(input, false);
    expect(card.text).toEqual({ label: 'Email', value: input.body });
    expect(card.lines).toContainEqual({ label: 'Subject', value: input.subject });
    expect(card.lines).toContainEqual({ label: 'For', value: 'Only you' });
    expect(card.figures).toEqual(['10:30am']);
    expect(card.notes.join(' ')).toMatch(/Saving sends nothing/);
    expect(templateCard(input, true).lines).toContainEqual({ label: 'For', value: 'The whole agency — anyone in it may send it' });
  });
});
