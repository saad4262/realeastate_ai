import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { CHAT_SCOPE_RULES, CHAT_SCOPES, chatAssistantName, chatScopeSkillFor } from './chat-scopes';
import { claimTurn } from './conversations';
import { ASSISTANT_WRITE_TOOLS } from './schema';

/** The user, 2026-11-10: Overview is the AI Assistant for everyday work; a skill's card opens that skill's own assistant. */

const actor: Actor = { userId: 'u1', agencyId: 'a1', membershipRole: 'owner' };
const general = CHAT_SCOPE_RULES.general.tools as readonly string[];
const WRITES = ASSISTANT_WRITE_TOOLS as readonly string[];

describe('the AI Assistant on Overview', () => {
  it('does everyday work: notes, leads, appointments, contacts and the team', () => {
    for (const t of ['add_note', 'set_lead_status', 'schedule_appointment', 'create_contact', 'update_contact', 'create_reminder', 'update_agent', 'remove_agent', 'invite_agent', 'find_agents', 'open_chat']) expect(general, t).toContain(t);
  });

  it('never does a skill’s job: that is the skill’s own assistant', () => {
    for (const t of ['send_template_email', 'send_email', 'send_template_sms', 'create_template', 'create_automation', 'create_workflow', 'change_workflow', 'create_dashboard', 'update_dashboard', 'create_listing_draft', 'update_listing', 'set_up_skill', 'change_skill', 'switch_skill']) expect(general, t).not.toContain(t);
  });

  it('a multi-step plan here holds only everyday steps', () => {
    const steps = CHAT_SCOPE_RULES.general.planSteps as readonly string[];
    for (const t of ['send_email', 'create_listing_draft', 'update_listing', 'schedule_team_meeting']) expect(steps).not.toContain(t);
    expect(steps).toContain('add_note');
  });

  it('a team change still answers to its own switch', () => {
    expect(chatScopeSkillFor('general', 'update_agent')).toBe('team_management');
    expect(chatScopeSkillFor('general', 'schedule_team_meeting')).toBe('team_meetings');
    expect(chatScopeSkillFor('general', 'add_note')).toBeUndefined();
  });

  it('every action of a skill’s assistant is that skill’s alone', () => {
    const skillChats = CHAT_SCOPES.filter((s) => s !== 'general' && s !== 'daily_work');
    const shared = new Set(['create_workflow', 'change_workflow', 'create_automation']);
    for (const tool of WRITES) {
      const holders = skillChats.filter((s) => (CHAT_SCOPE_RULES[s].tools as readonly string[]).includes(tool));
      if (!shared.has(tool) && holders.length) expect(holders, tool).toHaveLength(1);
    }
  });
});

describe('every chat is called by its assistant', () => {
  it('Overview, and a chat from before skills had chats, is the AI Assistant', () => {
    expect(chatAssistantName(null)).toBe('AI Assistant');
    expect(chatAssistantName('general')).toBe('AI Assistant');
  });
  it('a skill’s chat is that skill’s assistant, old names too', () => {
    expect(chatAssistantName('email')).toBe('Email Assistant');
    expect(chatAssistantName('bulk_email')).toBe('Email Assistant');
    expect(chatAssistantName('sms_automations')).toBe('SMS Assistant');
    expect(chatAssistantName('dashboards')).toBe('Dashboard Assistant');
  });
});

describe('a new Overview chat', () => {
  it('is the AI Assistant, with no switch to set', async () => {
    let written: unknown;
    const db = { insert: () => ({ values: (v: { chatScope: unknown }) => ((written = v.chatScope), { returning: async () => [{ id: 'c1' }] }) }) } as unknown as Db;
    expect((await claimTurn(db, actor, { message: 'hi', surface: 'agency' })).chatScope).toBe('general');
    expect(written).toBe('general');
  });
  it('an old chat with no kind is the AI Assistant too; its row is not changed', async () => {
    const db = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'c1', agencyId: 'a1', userId: 'u1', handles: {}, chatScope: null, turnCount: 1 }] }) }) }),
      select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }),
    } as unknown as Db;
    expect((await claimTurn(db, actor, { conversationId: 'c1', message: 'hi', surface: 'agency' })).chatScope).toBe('general');
  });
});

describe('on screen, read from source', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..', 'apps', 'console', 'components');
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
  it('Recents names the assistant of every chat, Overview’s included', () => {
    const recents = read('shell', 'recents-list.tsx');
    expect(recents).toContain('>{chatAssistantName(r.chatScope)}</span>');
    expect(recents).not.toContain('isOpenChatScope(r.chatScope) ?');
  });
  it('a skill’s chat says which assistant it is', () => {
    expect(read('assistant', 'assistant-home.tsx')).toContain('chatAssistantName(skillChat)');
  });
  it('no switch decides what Overview is any more', () => {
    expect(read('assistant', 'assistant-home.tsx')).not.toContain('overviewReadOnly');
  });
});
