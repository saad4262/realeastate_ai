import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readProposal } from '@repo/core/acting';
import { taskInputSchema } from '@repo/core/tasks';
import { automationInputSchema } from '@repo/core/automation';
import { PROPERTY_CHAT_V16 } from '../prompts/v16';
import { PROMPT_VERSION, PROPERTY_CHAT_V17 } from '../prompts/v17';
import { dispatchTool, PROPERTY_CHAT_TOOLS, type ToolContext } from './index';

const L = '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const SECRET = 'acting-tools-secret';
const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    places: new Map(),
    skillBlocks: new Map(),
    scheduling: { state: 'signed_out' },
    proposalSecret: SECRET,
    draftMessage: async (id: string) => (id === L ? { listingId: L, address: '12/1A Rogers Street, Pakenham', agencyName: 'Ray White Pakenham', text: "Hi,\n\nI'm interested…\n\nThanks", source: 'model', token: 'message.x.y', sentToday: 1, perDay: 5 } : { error: 'That home is not advertised on this site now.' }),
    ...over,
  }) as unknown as ToolContext;

describe('draft_message (ADR 0080, C8 decisions 1–2)', () => {
  it('puts the draft in a card and tells the guide it is not sent', async () => {
    const out = await dispatchTool('draft_message', { listingId: L }, ctx());
    expect(out.actingDraft).toMatchObject({ kind: 'message', to: 'Ray White Pakenham', listingId: L, sentToday: 1, perDay: 5 });
    expect(JSON.stringify(out.result)).toMatch(/never say it was sent/);
    expect(JSON.stringify(out.result)).not.toContain("I'm interested"); // the model is not handed the text to repeat
  });
  it('says why when it cannot; refused when the skill is off', async () => {
    expect((await dispatchTool('draft_message', { listingId: '7f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c' }, ctx())).isError).toBe(true);
    expect((await dispatchTool('draft_message', { listingId: L }, ctx({ skillBlocks: new Map([['agent_messages', 'switched_off']]) }))).isError).toBe(true);
  });
});

describe('draft_task (C8 decisions 5–6)', () => {
  it('a signed card the server describes; the token holds a task core accepts', async () => {
    const out = await dispatchTool('draft_task', { name: 'Monday in Pakenham', suburb: 'Pakenham', state: 'VIC', priceTo: 800000, bedrooms: 3, propertyType: 'house', sections: ['new_homes', 'sold'], cadence: 'weekly', atTime: '07:00', weekday: 1, timezone: 'Australia/Melbourne' }, ctx());
    expect(out.actingDraft).toMatchObject({ kind: 'task', title: 'Monday in Pakenham', lines: expect.arrayContaining(['Every Monday, 7:00 am', 'What sold']) });
    const t = readProposal('task', out.actingDraft!.token, z.unknown(), SECRET);
    expect(taskInputSchema.safeParse(t).success).toBe(true);
  });
  it('refuses five sections, a section that needs a suburb without one, and an unknown section', async () => {
    expect((await dispatchTool('draft_task', { name: 'x', sections: ['new_homes', 'sold', 'price_reduced', 'long_campaign', 'watched'], cadence: 'daily', atTime: '07:00' }, ctx())).isError).toBe(true);
    expect((await dispatchTool('draft_task', { name: 'x', state: 'VIC', sections: ['sold'], cadence: 'daily', atTime: '07:00' }, ctx())).isError).toBe(true);
    expect((await dispatchTool('draft_task', { name: 'x', sections: ['email_agent'], cadence: 'daily', atTime: '07:00' }, ctx())).isError).toBe(true);
  });
});

describe('draft_automation (C8 decisions 8–9)', () => {
  it('a card for a fitting rule', async () => {
    const out = await dispatchTool('draft_automation', { trigger: 'price_reduced', scope: 'shortlist', action: 'tell' }, ctx());
    expect(out.actingDraft).toMatchObject({ kind: 'automation', title: 'When a home on my shortlist has its price reduced → Tell me', lines: ['once a day at 8 am'] });
    expect(automationInputSchema.safeParse(readProposal('automation', out.actingDraft!.token, z.unknown(), SECRET)).success).toBe(true);
  });
  it('has no way to reach an agent, and refuses a rule that does not fit', async () => {
    const schema = PROPERTY_CHAT_TOOLS.find((t) => t.name === 'draft_automation')!.input_schema as { properties: { action: { enum: string[] } } };
    expect(schema.properties.action.enum).toEqual(['tell', 'shortlist_add', 'shortlist_remove']);
    expect((await dispatchTool('draft_automation', { trigger: 'price_reduced', scope: 'shortlist', action: 'enquire' }, ctx())).isError).toBe(true);
    expect((await dispatchTool('draft_automation', { trigger: 'price_reduced', scope: 'shortlist', action: 'shortlist_remove' }, ctx())).isError).toBe(true);
    expect((await dispatchTool('draft_automation', { trigger: 'sold', scope: 'shortlist', action: 'tell' }, ctx({ proposalSecret: null }))).isError).toBe(true);
  });
});

describe('prompt v17', () => {
  it('builds on v16, counts nineteen tools, has no date, and says nothing acts before the visitor does', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v17');
    expect(PROPERTY_CHAT_V17.startsWith(PROPERTY_CHAT_V16.slice(0, 200))).toBe(true);
    expect(PROPERTY_CHAT_V17).toContain('You have nineteen tools.');
    expect(PROPERTY_CHAT_TOOLS.length).toBeGreaterThanOrEqual(19); // C9 adds more (v18+)
    expect(PROPERTY_CHAT_V17).not.toMatch(/new Date|\d{4}-\d{2}-\d{2}/);
    expect(PROPERTY_CHAT_V17).toMatch(/Never say "I've sent", "I've set up" or "it's running"/);
    expect(PROPERTY_CHAT_V17).toMatch(/never contact an agent/);
  });
});
