import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { approveProposedAction } from './actions';
import { CHAT_SCOPE_FACE, CHAT_SCOPE_RULES, CHAT_SCOPES, OPEN_CHAT_SCOPES, SHARED_ACTION_TOOLS, UNSCOPED_ACTION_TOOLS, chatScopeAllowsCard, chatScopeOfSkill, chatScopeRefusal, isOpenChatScope, parseChatScope, templateChannel, type ChatScope } from './chat-scopes';
import { claimTurn } from './conversations';
import { ASSISTANT_READ_TOOLS, ASSISTANT_TOOL_NAMES, ASSISTANT_WRITE_TOOLS, PLANNABLE_TOOLS, assistantTurnRequestSchema } from './schema';
import { runAssistantTool } from './tools';

/** ADR 0088: what keeps one chat out of another's work, all of it without a database or a model. */

const WRITES = ASSISTANT_WRITE_TOOLS as readonly string[];
const holders = (tool: string) => CHAT_SCOPES.filter((s) => (CHAT_SCOPE_RULES[s].tools as readonly string[]).includes(tool));
const actor: Actor = { userId: 'u1', agencyId: 'a1', membershipRole: 'owner' };

describe('the registry', () => {
  it('names only tools that exist, each once', () => {
    for (const s of CHAT_SCOPES) {
      for (const t of CHAT_SCOPE_RULES[s].tools) expect(ASSISTANT_TOOL_NAMES).toContain(t);
      expect(new Set(CHAT_SCOPE_RULES[s].tools).size).toBe(CHAT_SCOPE_RULES[s].tools.length);
    }
  });

  it('Overview has no action tool at all', () => {
    expect(CHAT_SCOPE_RULES.general.tools.filter((t) => WRITES.includes(t))).toEqual([]);
    expect(CHAT_SCOPE_RULES.general.tools.every((t) => (ASSISTANT_READ_TOOLS as readonly string[]).includes(t))).toBe(true);
  });

  it('every action tool belongs to exactly one chat, unless it is named as shared or as in none', () => {
    for (const tool of ASSISTANT_WRITE_TOOLS) {
      const n = holders(tool).length;
      if ((SHARED_ACTION_TOOLS as readonly string[]).includes(tool)) expect(n, tool).toBeGreaterThan(1);
      else if ((UNSCOPED_ACTION_TOOLS as readonly string[]).includes(tool)) expect(n, tool).toBe(0);
      else expect(n, `${tool} is in: ${holders(tool).join(', ')}`).toBe(1);
    }
  });

  it('only the two automations chats may build a workflow, and each refuses the other channel', () => {
    expect(holders('create_workflow').sort()).toEqual(['email_automations', 'sms_automations']);
    expect(holders('change_workflow').sort()).toEqual(['email_automations', 'sms_automations']);
    expect(CHAT_SCOPE_RULES.email_automations.refusedWorkflowSteps).toContain('send_template_sms');
    expect(CHAT_SCOPE_RULES.sms_automations.refusedWorkflowSteps).toEqual(expect.arrayContaining(['send_template_email', 'draft_email']));
  });

  it('a multi-step plan is only in Daily work, and cannot carry another chat’s action', () => {
    expect(holders('plan_task')).toEqual(['daily_work']);
    const steps = CHAT_SCOPE_RULES.daily_work.planSteps as readonly string[];
    for (const s of steps) expect(PLANNABLE_TOOLS as readonly string[]).toContain(s);
    for (const t of ['send_email', 'schedule_team_meeting', 'create_listing_draft', 'update_listing', 'withdraw_listing', 'submit_listing']) expect(steps).not.toContain(t);
  });

  it('every chat that lists templates has its channel set, or is Overview, which only reads', () => {
    for (const s of holders('list_templates')) if (s !== 'general') expect(CHAT_SCOPE_RULES[s].channel, s).toBeDefined();
  });
});

describe('what can be opened', () => {
  it('is only what has been built', () => {
    expect(OPEN_CHAT_SCOPES).toEqual(['bulk_email']);
    expect(isOpenChatScope('bulk_email')).toBe(true);
    for (const s of ['bulk_sms', 'general', null, undefined, 'nope']) expect(isOpenChatScope(s as string)).toBe(false);
  });
  it('every open chat has its skill and its face', () => {
    for (const s of OPEN_CHAT_SCOPES) {
      expect(CHAT_SCOPE_RULES[s].skill, s).toBeDefined();
      expect(CHAT_SCOPE_FACE[s].suggestions.length, s).toBeGreaterThan(0);
    }
  });
  it('a Skills card finds its chat by the skill’s key', () => {
    expect(chatScopeOfSkill('bulk_email')).toBe('bulk_email');
    expect(chatScopeOfSkill('cold_contacts')).toBeNull();
  });
  it('the request carries a scope only as one of the known ones', () => {
    const base = { message: 'hi', timeZone: 'UTC' };
    expect(assistantTurnRequestSchema.safeParse({ ...base, chatScope: 'bulk_email' }).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ ...base, chatScope: 'everything' }).success).toBe(false);
  });
});

describe('the home and the hook, read from source', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..', 'apps', 'console', 'components');
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
  it('a scope is only sent to start a chat, never with an existing one', () => {
    expect(read('assistant', 'use-assistant.ts')).toContain('...(conversationId ? { conversationId } : newChatScope ? { chatScope: newChatScope } : {}),');
  });
  it('the URL only offers a chat that exists, and never while another is open', () => {
    expect(read('assistant', 'assistant-home.tsx')).toContain('newChatScope: !c && isOpenChatScope(chatParam) ? chatParam : null');
  });
  it('a card offers its chat only while the skill is on', () => {
    expect(read('skills', 'platform-skills.tsx')).toContain('const scope = s.on ? chatScopeOfSkill(s.key) : null;');
  });
});

describe('parseChatScope', () => {
  it('null stays null, a chat from before the ADR', () => {
    expect(parseChatScope(null)).toBeNull();
    expect(parseChatScope(undefined)).toBeNull();
  });
  it('a value this code does not know gets the fewest tools, never every tool', () => {
    expect(parseChatScope('bulk_everything')).toBe('general');
  });
  it('keeps a known one', () => {
    expect(parseChatScope('bulk_sms')).toBe('bulk_sms');
  });
});

describe('chatScopeRefusal', () => {
  it('lets a chat from before the ADR do everything', () => {
    for (const t of ASSISTANT_TOOL_NAMES) expect(chatScopeRefusal(null, t, {})).toBeNull();
  });
  it('refuses another chat’s tool', () => {
    expect(chatScopeRefusal('bulk_email', 'send_email', {})).toContain('Bulk email');
    expect(chatScopeRefusal('bulk_email', 'create_workflow', {})).not.toBeNull();
    expect(chatScopeRefusal('general', 'add_note', {})).not.toBeNull();
    expect(chatScopeRefusal('bulk_email', 'send_template_email', {})).toBeNull();
  });
  it('holds a plan to its own steps', () => {
    expect(chatScopeRefusal('daily_work', 'plan_task', { steps: [{ tool: 'add_note' }, { tool: 'remind' }] })).toBeNull();
    expect(chatScopeRefusal('daily_work', 'plan_task', { steps: [{ tool: 'add_note' }, { tool: 'send_email' }] })).not.toBeNull();
  });
  it('finds the other channel’s send step, in the plain steps and inside a decision', () => {
    const sms = { type: 'send_template_sms' };
    const note = { type: 'add_note' };
    expect(chatScopeRefusal('email_automations', 'create_workflow', { actions: [note, sms] })).not.toBeNull();
    expect(chatScopeRefusal('email_automations', 'create_workflow', { actions: [note], decide: { choices: [{ actions: [note] }, { actions: [sms] }] } })).not.toBeNull();
    expect(chatScopeRefusal('email_automations', 'create_workflow', { actions: [note, { type: 'send_template_email' }] })).toBeNull();
    expect(chatScopeRefusal('sms_automations', 'create_workflow', { actions: [{ type: 'draft_email' }] })).not.toBeNull();
    expect(chatScopeRefusal('sms_automations', 'create_workflow', { actions: [sms] })).toBeNull();
  });
});

describe('templateChannel and chatScopeAllowsCard', () => {
  it('the chat sets the channel, whatever the model asked for', () => {
    expect(templateChannel('bulk_sms', 'email')).toBe('sms');
    expect(templateChannel('bulk_sms', undefined)).toBe('sms');
    expect(templateChannel('bulk_email', 'sms')).toBe('email');
    expect(templateChannel(null, 'sms')).toBe('sms');
    expect(templateChannel(null, undefined)).toBe('email');
  });
  it('a card must be this chat’s; a reminder step needs a plan', () => {
    expect(chatScopeAllowsCard(null, 'send_email')).toBe(true);
    expect(chatScopeAllowsCard('bulk_email', 'send_template_email')).toBe(true);
    expect(chatScopeAllowsCard('bulk_email', 'send_email')).toBe(false);
    expect(chatScopeAllowsCard('daily_work', 'remind')).toBe(true);
    expect(chatScopeAllowsCard('bulk_email', 'remind')).toBe(false);
  });
});

describe('runAssistantTool in a chat', () => {
  const ctx = (chatScope: ChatScope | null) => ({ db: {} as Db, actor, timeZone: 'UTC', handles: {}, now: new Date(), chatScope });

  it('refuses another chat’s tool before it touches the database', async () => {
    const out = await runAssistantTool(ctx('bulk_email'), 'add_note', { contact: 'C1', body: 'hello' } as never);
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toContain('Bulk email');
  });

  const template = { name: 'Spring', subject: 'Hello', body: 'Words' };
  const off = { skillsOff: async () => new Set(['bulk_email'] as const) };

  it('a skill chat’s action needs its skill on', async () => {
    const out = await runAssistantTool({ ...ctx('bulk_email'), ...off }, 'create_template', template);
    expect(JSON.stringify(out.result)).toContain('switched off');
  });

  it('reading still works with the skill off, so the chat can say what is wrong', async () => {
    const reached = await runAssistantTool({ ...ctx('bulk_email'), ...off }, 'find_saved_lists', {}).then((o) => JSON.stringify(o.result), () => 'reached the database');
    expect(reached).not.toContain('switched off');
  });

  it('a chat from before the ADR is not gated by this switch: nothing changes for it', async () => {
    const reached = await runAssistantTool({ ...ctx(null), ...off }, 'create_template', template).then((o) => JSON.stringify(o.result), () => 'reached the database');
    expect(reached).not.toContain('switched off');
  });

  it('refuses a read tool that is not this chat’s, too', async () => {
    const out = await runAssistantTool(ctx('bulk_email'), 'find_skills', {});
    expect(JSON.stringify(out.result)).toContain('Bulk email');
  });
});

/** A database that answers each select from a list, and fails the test if anything writes. */
function selectsOnly(rows: unknown[][]) {
  const chain = (result: unknown[]) => ({ from: () => ({ where: () => ({ limit: async () => result }) }) });
  return { select: () => chain(rows.shift() ?? []), transaction: () => { throw new Error('must not write'); } } as unknown as Db;
}

describe('Approve in a chat', () => {
  const card = (tool: string, conversationId: string | null) => ({ id: 'p1', agencyId: 'a1', userId: 'u1', conversationId, tool, status: 'proposed' });

  it('refuses a card that is not this chat’s, before anything runs', async () => {
    const db = selectsOnly([[card('send_email', 'c1')], [{ chatScope: 'bulk_email' }]]);
    await expect(approveProposedAction(db, actor, '00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('does not refuse a card in a chat from before the ADR', async () => {
    const db = selectsOnly([[card('send_email', 'c1')], [{ chatScope: null }]]);
    await expect(approveProposedAction(db, actor, '00000000-0000-4000-8000-000000000001')).rejects.toThrow('must not write');
  });

  it('refuses this chat’s own card once its skill is off', async () => {
    const db = selectsOnly([[card('send_template_email', 'c1')], [{ chatScope: 'bulk_email' }], [{ enabled: false }]]);
    await expect(approveProposedAction(db, actor, '00000000-0000-4000-8000-000000000001')).rejects.toThrow('switched off');
  });

  it('runs this chat’s own card while its skill is on', async () => {
    const db = selectsOnly([[card('send_template_email', 'c1')], [{ chatScope: 'bulk_email' }], [{ enabled: true }]]);
    await expect(approveProposedAction(db, actor, '00000000-0000-4000-8000-000000000001')).rejects.toThrow('must not write');
  });

  it('does not refuse a workflow’s card, which has no chat', async () => {
    const db = selectsOnly([[card('send_email', null)]]);
    await expect(approveProposedAction(db, actor, '00000000-0000-4000-8000-000000000001')).rejects.toThrow('must not write');
  });
});

describe('claimTurn', () => {
  const noMessages = { select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }) };

  it('takes an existing chat’s scope from its row, never from the request', async () => {
    const db = {
      ...noMessages,
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'c1', agencyId: 'a1', userId: 'u1', handles: {}, chatScope: 'bulk_email', turnCount: 1 }] }) }) }),
    } as unknown as Db;
    const claim = await claimTurn(db, actor, { conversationId: 'c1', message: 'hi', surface: 'agency', chatScope: 'bulk_sms' });
    expect(claim.chatScope).toBe('bulk_email');
  });

  const switchIs = (enabled: boolean) => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ enabled }] }) }) }) });

  it('writes the scope once, when the chat is made', async () => {
    let written: unknown;
    const db = {
      ...switchIs(true),
      insert: () => ({ values: (v: { chatScope: unknown }) => { written = v.chatScope; return { returning: async () => [{ id: 'c2' }] }; } }),
    } as unknown as Db;
    const claim = await claimTurn(db, actor, { message: 'hi', surface: 'agency', chatScope: 'bulk_email' });
    expect(written).toBe('bulk_email');
    expect(claim.chatScope).toBe('bulk_email');
  });

  it('will not start a chat that is not built yet, whatever the browser sends', async () => {
    const db = { ...switchIs(true), insert: () => { throw new Error('must not write'); } } as unknown as Db;
    await expect(claimTurn(db, actor, { message: 'hi', surface: 'agency', chatScope: 'bulk_sms' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('will not start a chat whose skill is off', async () => {
    const db = { ...switchIs(false), insert: () => { throw new Error('must not write'); } } as unknown as Db;
    await expect(claimTurn(db, actor, { message: 'hi', surface: 'agency', chatScope: 'bulk_email' })).rejects.toThrow('switched off');
  });

  it('a chat made without one is the old kind', async () => {
    const db = { insert: () => ({ values: () => ({ returning: async () => [{ id: 'c3' }] }) }) } as unknown as Db;
    expect((await claimTurn(db, actor, { message: 'hi', surface: 'agency' })).chatScope).toBeNull();
  });
});
