import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { PLATFORM_SKILLS } from '../skill-switches/catalog';
import { approveProposedAction } from './actions';
import { CHAT_SCOPE_FACE, CHAT_SCOPE_RULES, CHAT_SCOPES, OPEN_CHAT_SCOPES, SCOPE_ONLY_TOOLS, SHARED_ACTION_TOOLS, UNSCOPED_ACTION_TOOLS, chatScopeAllowsCard, chatScopeOfSkill, chatScopeRefusal, isOpenChatScope, parseChatScope, templateChannel, workflowFitsChat, type ChatScope } from './chat-scopes';
import { claimTurn } from './conversations';
import { ASSISTANT_READ_TOOLS, ASSISTANT_TOOL_NAMES, ASSISTANT_WRITE_TOOLS, PLANNABLE_TOOLS, PROPOSED_ACTION_TOOLS, assistantTurnRequestSchema } from './schema';
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

  it('Overview’s AI Assistant does no skill’s job', () => {
    const skillTools = ['email', 'sms', 'listing_copy', 'dashboards', 'ai_skills'].flatMap((x) => CHAT_SCOPE_RULES[x as ChatScope].tools as readonly string[]).filter((t) => WRITES.includes(t));
    expect(CHAT_SCOPE_RULES.general.tools.filter((t) => skillTools.includes(t))).toEqual([]);
  });

  it('every action tool belongs to exactly one chat, unless it is named as shared or as in none', () => {
    for (const tool of ASSISTANT_WRITE_TOOLS) {
      // Overview's AI Assistant shares team work with the Team and Meetings assistants: count the skills' own chats.
      const n = holders(tool).filter((h) => h !== 'general').length;
      if ((SHARED_ACTION_TOOLS as readonly string[]).includes(tool)) expect(n, tool).toBeGreaterThan(1);
      else if ((UNSCOPED_ACTION_TOOLS as readonly string[]).includes(tool)) expect(n, tool).toBe(0);
      else if (n) expect(n, `${tool} is in: ${holders(tool).join(', ')}`).toBe(1);
      else expect(holders(tool).length, tool).toBeGreaterThan(0);
    }
  });

  it('only the two automations chats may build a workflow, and each refuses the other channel', () => {
    expect(holders('create_workflow').sort()).toEqual(['email', 'sms']);
    expect(holders('change_workflow').sort()).toEqual(['email', 'sms']);
    expect(CHAT_SCOPE_RULES.email.refusedWorkflowSteps).toContain('send_template_sms');
    expect(CHAT_SCOPE_RULES.sms.refusedWorkflowSteps).toEqual(expect.arrayContaining(['send_template_email', 'draft_email']));
  });

  it('a multi-step plan is only everyday work, and cannot carry another chat’s action', () => {
    expect(holders('plan_task')).toEqual(['general']);
    for (const scope of ['general'] as const) {
      const steps = CHAT_SCOPE_RULES[scope].planSteps as readonly string[];
      for (const st of steps) expect(PLANNABLE_TOOLS as readonly string[]).toContain(st);
      for (const t of ['send_email', 'schedule_team_meeting', 'create_listing_draft', 'update_listing', 'withdraw_listing', 'submit_listing']) expect(steps).not.toContain(t);
    }
  });

  it('every chat that lists templates has its channel set, or is Overview, which only reads', () => {
    for (const s of holders('list_templates')) if (s !== 'general') expect(CHAT_SCOPE_RULES[s].channel, s).toBeDefined();
  });
});

describe('Overview’s way out', () => {
  it('the way out reads, and only Overview has it', () => {
    expect((ASSISTANT_READ_TOOLS as readonly string[]).includes('open_chat')).toBe(true);
    expect(holders('open_chat')).toEqual(['general']);
  });
});

describe('open_chat', () => {
  const noDb = {} as Db;
  const ctx = (over: object = {}) => ({ db: noDb, actor, timeZone: 'UTC', handles: {}, now: new Date(), chatScope: 'general' as ChatScope, ...over });
  const on = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ enabled: true }] }) }) }) } as unknown as Db;
  const off = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as unknown as Db;

  it('puts a button for a chat that is on, with what they asked typed in for them', async () => {
    const out = await runAssistantTool(ctx({ db: on }), 'open_chat', { chat: 'email', message: 'email my buyers' });
    expect(out.frame).toEqual({ kind: 'open_chat', scope: 'email', name: 'Email', on: true, ask: 'email my buyers' });
  });
  it('a chat whose skill is off sends them to Skills instead, carrying nothing', async () => {
    const out = await runAssistantTool(ctx({ db: off }), 'open_chat', { chat: 'email', message: 'email my buyers' });
    expect(out.frame).toMatchObject({ on: false, ask: null });
  });
  it('a chat with no switch is always on, with no read', async () => {
    const out = await runAssistantTool(ctx(), 'open_chat', { chat: 'ai_skills' });
    expect(out.frame).toMatchObject({ on: true });
  });
  it('an agent gets no button for the team chat', async () => {
    const out = await runAssistantTool(ctx({ db: on, actor: { ...actor, membershipRole: 'agent' } }), 'open_chat', { chat: 'team_management' });
    expect(out.frame).toBeUndefined();
    expect(JSON.stringify(out.result)).toContain('owner or admin');
  });
  it('will not name a chat that cannot be opened', async () => {
    expect((await runAssistantTool(ctx(), 'open_chat', { chat: 'general' })).isError).toBe(true);
  });
  it('only Overview may use it', async () => {
    expect((await runAssistantTool(ctx({ chatScope: 'email' }), 'open_chat', { chat: 'ai_skills' })).isError).toBe(true);
    expect((await runAssistantTool(ctx({ chatScope: null }), 'open_chat', { chat: 'ai_skills' })).isError).toBe(true);
  });
});

describe('a repeating automation from a chat (ADR 0089)', () => {
  it('only Email and SMS can make one, and its card is approvable there', () => {
    expect(holders('create_automation').sort()).toEqual(['email', 'sms']);
    expect(chatScopeAllowsCard('email', 'create_workflow')).toBe(true);
    expect(chatScopeRefusal(null, 'create_automation', {})).not.toBeNull();
  });
  it('its card is stored as a create_workflow, so the database CHECK does not change', () => {
    expect(PROPOSED_ACTION_TOOLS as readonly string[]).not.toContain('create_automation');
  });
});

describe('what can be opened', () => {
  it('is only what has been built', () => {
    expect(CHAT_SCOPES.filter((s) => !(OPEN_CHAT_SCOPES as readonly string[]).includes(s))).toEqual(['general']);
    expect(isOpenChatScope('sms')).toBe(true);
    for (const s of ['general', null, undefined, 'nope']) expect(isOpenChatScope(s as string)).toBe(false);
  });
  it('every open chat has its face, and a skill unless it is the one with no switch', () => {
    for (const s of OPEN_CHAT_SCOPES) {
      expect(CHAT_SCOPE_FACE[s].suggestions.length, s).toBeGreaterThan(0);
      if (s !== 'ai_skills') expect(CHAT_SCOPE_RULES[s].skill, s).toBeDefined();
    }
  });
  it('a Skills card finds its chat', () => {
    expect(chatScopeOfSkill('ai_listing_copy')).toBe('listing_copy');
    expect(chatScopeOfSkill('workflow_texts')).toBe('sms');
    expect(chatScopeOfSkill('cold_contacts')).toBeNull();
  });
  it('a skill that runs by itself has no chat, except the two whose workflows are built in one', () => {
    const auto = PLATFORM_SKILLS.filter((p) => p.level === 'auto' && chatScopeOfSkill(p.key)).map((p) => p.key).sort();
    expect(auto).toEqual(['workflow_emails', 'workflow_texts']);
  });
  it('the request carries a scope only as one of the known ones', () => {
    const base = { message: 'hi', timeZone: 'UTC' };
    expect(assistantTurnRequestSchema.safeParse({ ...base, chatScope: 'email' }).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ ...base, chatScope: 'everything' }).success).toBe(false);
  });
});

describe('Overview’s pages and button, read from source', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..', 'apps', 'console');
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
  it('the button only types the request in, and goes to Skills when the skill is off', () => {
    const panel = read('components', 'assistant', 'assistant-panel.tsx');
    expect(panel).toContain('frame.on ? `${p.home}?chat=${frame.scope}${frame.ask ? `&ask=${encodeURIComponent(frame.ask)}` : \'\'}` : p.skills');
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
  it('a failed list of a skill’s chats leaves the Skills page standing: it is only a few links under a card', () => {
    expect(read('skills', 'platform-skills.tsx')).toContain('listAssistantConversations(db, actor, new Date(), 30, { chatScopes: STORED_OPEN_CHAT_SCOPES }).catch(() => [])');
  });
  it('a card offers its chat only while the skill is on', () => {
    const card = read('skills', 'platform-skills.tsx');
    expect(card).toContain('const scope = skillIsUsable(s, holder) ? chatScopeOfSkill(s.key) : null;');
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
    expect(parseChatScope('sms')).toBe('sms');
  });
});

describe('chatScopeRefusal', () => {
  it('lets a chat from before the ADR do everything it could', () => {
    for (const t of ASSISTANT_TOOL_NAMES) if (!(SCOPE_ONLY_TOOLS as readonly string[]).includes(t)) expect(chatScopeRefusal(null, t, {})).toBeNull();
  });
  it('refuses another chat’s tool', () => {
    expect(chatScopeRefusal('email', 'add_note', {})).toContain('Email');
    expect(chatScopeRefusal('email', 'schedule_appointment', {})).not.toBeNull();
    expect(chatScopeRefusal('general', 'send_template_email', {})).not.toBeNull();
    expect(chatScopeRefusal('email', 'send_template_email', {})).toBeNull();
  });
  it('a skill chat’s own tool is refused in a chat from before the ADR, and in any other chat', () => {
    expect(chatScopeRefusal(null, 'send_template_sms', {})).not.toBeNull();
    expect(chatScopeRefusal('email', 'send_template_sms', {})).not.toBeNull();
    expect(chatScopeRefusal('sms', 'send_template_sms', {})).toBeNull();
  });
  it('holds a plan to its own steps', () => {
    expect(chatScopeRefusal('general', 'plan_task', { steps: [{ tool: 'add_note' }, { tool: 'remind' }] })).toBeNull();
    expect(chatScopeRefusal('general', 'plan_task', { steps: [{ tool: 'add_note' }, { tool: 'send_email' }] })).not.toBeNull();
  });
  it('finds the other channel’s send step, in the plain steps and inside a decision', () => {
    const sms = { type: 'send_template_sms' };
    const note = { type: 'add_note' };
    expect(chatScopeRefusal('email', 'create_workflow', { actions: [note, sms] })).not.toBeNull();
    expect(chatScopeRefusal('email', 'create_workflow', { actions: [note], decide: { choices: [{ actions: [note] }, { actions: [sms] }] } })).not.toBeNull();
    expect(chatScopeRefusal('email', 'create_workflow', { actions: [note, { type: 'send_template_email' }] })).toBeNull();
    expect(chatScopeRefusal('sms', 'create_workflow', { actions: [{ type: 'draft_email' }] })).not.toBeNull();
    expect(chatScopeRefusal('sms', 'create_workflow', { actions: [sms] })).toBeNull();
  });
});

describe('templateChannel and chatScopeAllowsCard', () => {
  it('the chat sets the channel, whatever the model asked for', () => {
    expect(templateChannel('sms', 'email')).toBe('sms');
    expect(templateChannel('sms', undefined)).toBe('sms');
    expect(templateChannel('email', 'sms')).toBe('email');
    expect(templateChannel(null, 'sms')).toBe('sms');
    expect(templateChannel(null, undefined)).toBe('email');
  });
  it('a card must be this chat’s; a reminder step needs a plan', () => {
    expect(chatScopeAllowsCard(null, 'send_email')).toBe(true);
    expect(chatScopeAllowsCard('email', 'send_template_email')).toBe(true);
    expect(chatScopeAllowsCard('email', 'add_note')).toBe(false);
    expect(chatScopeAllowsCard('general', 'remind')).toBe(true);
    expect(chatScopeAllowsCard('email', 'remind')).toBe(false);
  });
  it('a long bulk email is a plan card, and Approve lets it through there and nowhere it should not', () => {
    expect(chatScopeAllowsCard('email', 'plan_task')).toBe(true);
    expect(chatScopeAllowsCard('general', 'plan_task')).toBe(true);
    for (const s of ['sms', 'listing_copy', 'dashboards'] as const) expect(chatScopeAllowsCard(s, 'plan_task')).toBe(false);
  });
  it('a stored workflow fits a chat only if it holds none of the other channel’s sends', () => {
    expect(workflowFitsChat(null, ['send_template_sms', 'send_template_email'])).toBe(true);
    expect(workflowFitsChat('email', ['add_note', 'send_template_email'])).toBe(true);
    expect(workflowFitsChat('email', ['send_template_email', 'send_template_sms'])).toBe(false);
    expect(workflowFitsChat('sms', ['draft_email'])).toBe(false);
    expect(workflowFitsChat('sms', ['send_template_sms', 'wait'])).toBe(true);
  });
});

describe('runAssistantTool in a chat', () => {
  const ctx = (chatScope: ChatScope | null) => ({ db: {} as Db, actor, timeZone: 'UTC', handles: {}, now: new Date(), chatScope });

  it('refuses another chat’s tool before it touches the database', async () => {
    const out = await runAssistantTool(ctx('email'), 'add_note', { contact: 'C1', body: 'hello' } as never);
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.result)).toContain('Email');
  });

  const template = { name: 'Spring', subject: 'Hello', body: 'Words' };
  const off = { skillsOff: async () => new Set(['bulk_email'] as const) };

  it('a skill chat’s action needs its skill on', async () => {
    const out = await runAssistantTool({ ...ctx('email'), ...off }, 'create_template', template);
    expect(JSON.stringify(out.result)).toContain('switched off');
  });

  it('reading still works with the skill off, so the chat can say what is wrong', async () => {
    const reached = await runAssistantTool({ ...ctx('email'), ...off }, 'find_saved_lists', {}).then((o) => JSON.stringify(o.result), () => 'reached the database');
    expect(reached).not.toContain('switched off');
  });

  it('a chat from before the ADR is not gated by this switch: nothing changes for it', async () => {
    const reached = await runAssistantTool({ ...ctx(null), ...off }, 'create_template', template).then((o) => JSON.stringify(o.result), () => 'reached the database');
    expect(reached).not.toContain('switched off');
  });

  it('refuses a read tool that is not this chat’s, too', async () => {
    const out = await runAssistantTool(ctx('email'), 'find_skills', {});
    expect(JSON.stringify(out.result)).toContain('Email');
  });
});

/** A database that answers each select from a list, and fails the test if anything writes. */
function selectsOnly(rows: unknown[][]) {
  const chain = (result: unknown[]) => ({ from: () => ({ where: () => ({ limit: async () => result }) }) });
  return { select: () => chain(rows.shift() ?? []), transaction: () => { throw new Error('must not write'); } } as unknown as Db;
}

describe('Approve in a chat', () => {
  const card = (tool: string, conversationId: string | null) => ({ id: 'p1', agencyId: 'a1', userId: 'u1', conversationId, tool, status: 'proposed', args: {} });

  it('refuses a card that is not this chat’s, before anything runs', async () => {
    const db = selectsOnly([[card('add_note', 'c1')], [{ chatScope: 'email' }]]);
    await expect(approveProposedAction(db, actor, '00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('does not refuse a card in a chat from before the ADR', async () => {
    const db = selectsOnly([[card('send_email', 'c1')], [{ chatScope: null }]]);
    await expect(approveProposedAction(db, actor, '00000000-0000-4000-8000-000000000001')).rejects.toThrow('must not write');
  });

  it('refuses this chat’s own card once its skill is off', async () => {
    const db = selectsOnly([[card('send_template_email', 'c1')], [{ chatScope: 'email' }], [{ enabled: false }]]);
    await expect(approveProposedAction(db, actor, '00000000-0000-4000-8000-000000000001')).rejects.toThrow('switched off');
  });

  it('runs this chat’s own card while its skill is on', async () => {
    const db = selectsOnly([[card('send_template_email', 'c1')], [{ chatScope: 'email' }], [{ enabled: true }]]);
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
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'c1', agencyId: 'a1', userId: 'u1', handles: {}, chatScope: 'email', turnCount: 1 }] }) }) }),
    } as unknown as Db;
    const claim = await claimTurn(db, actor, { conversationId: 'c1', message: 'hi', surface: 'agency', chatScope: 'sms' });
    expect(claim.chatScope).toBe('email');
  });

  const switchIs = (enabled: boolean) => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ enabled }] }) }) }) });

  it('writes the scope once, when the chat is made', async () => {
    let written: unknown;
    const db = {
      ...switchIs(true),
      insert: () => ({ values: (v: { chatScope: unknown }) => { written = v.chatScope; return { returning: async () => [{ id: 'c2' }] }; } }),
    } as unknown as Db;
    const claim = await claimTurn(db, actor, { message: 'hi', surface: 'agency', chatScope: 'email' });
    expect(written).toBe('email');
    expect(claim.chatScope).toBe('email');
  });

  it('will not start a chat that is not built yet, whatever the browser sends', async () => {
    const db = { ...switchIs(true), insert: () => { throw new Error('must not write'); } } as unknown as Db;
    await expect(claimTurn(db, actor, { message: 'hi', surface: 'agency', chatScope: 'general' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('will not open the team chat for an agent, even by the URL, though it is no switch of theirs', async () => {
    const db = { ...switchIs(true), insert: () => { throw new Error('must not write'); } } as unknown as Db;
    await expect(claimTurn(db, { ...actor, membershipRole: 'agent' }, { message: 'hi', surface: 'agent', chatScope: 'team_management' })).rejects.toThrow('owner or admin');
  });

  it('a pair skill needs the agency’s switch as well as the agent’s', async () => {
    const pair = (rows: { userId: string | null; enabled: boolean }[]) => ({ select: () => ({ from: () => ({ where: async () => rows }) }), insert: () => ({ values: () => ({ returning: async () => [{ id: 'c9' }] }) }) });
    const me = { ...actor, membershipRole: 'agent' } as Actor;
    await expect(claimTurn(pair([{ userId: me.userId, enabled: true }]) as unknown as Db, me, { message: 'hi', surface: 'agent', chatScope: 'sms' })).rejects.toThrow('switched off');
    const both = [{ userId: null, enabled: true }, { userId: me.userId, enabled: true }];
    expect((await claimTurn(pair(both) as unknown as Db, me, { message: 'hi', surface: 'agent', chatScope: 'sms' })).chatScope).toBe('sms');
  });

  it('will not start a chat whose skill is off', async () => {
    const db = { ...switchIs(false), insert: () => { throw new Error('must not write'); } } as unknown as Db;
    await expect(claimTurn(db, actor, { message: 'hi', surface: 'agency', chatScope: 'email' })).rejects.toThrow('switched off');
  });

  it('the browser cannot ask for the AI Assistant’s scope: it is what a chat with none becomes', async () => {
    const db = { insert: () => ({ values: () => ({ returning: async () => [{ id: 'c2' }] }) }) } as unknown as Db;
    await expect(claimTurn(db, actor, { message: 'hi', surface: 'agency', chatScope: 'general' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a chat made without one is the AI Assistant’s', async () => {
    const db = { insert: () => ({ values: () => ({ returning: async () => [{ id: 'c3' }] }) }) } as unknown as Db;
    expect((await claimTurn(db, actor, { message: 'hi', surface: 'agency' })).chatScope).toBe('general');
  });
});
