import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { CHAT_SCOPE_LABELS, CHAT_SCOPE_RULES, CHAT_SCOPES, OPEN_CHAT_SCOPES, STORED_OPEN_CHAT_SCOPES, chatScopeOfSkill, chatScopeRefusal, chatScopeSkillFor, parseChatScope, skillKeyOfChatScope, templateChannel } from './chat-scopes';
import { claimTurn } from './conversations';

/** One Email assistant and one SMS assistant: a workflow is only when; the sending is the same job. */

const actor: Actor = { userId: 'u1', agencyId: 'a1', membershipRole: 'owner' };

describe('the two combined chats', () => {
  it('replace the five separate ones', () => {
    for (const old of ['bulk_email', 'ai_email_drafts', 'email_automations', 'bulk_sms', 'sms_automations']) expect(CHAT_SCOPES as readonly string[]).not.toContain(old);
    expect(OPEN_CHAT_SCOPES as readonly string[]).toEqual(expect.arrayContaining(['email', 'sms']));
    expect(CHAT_SCOPE_LABELS.email).toBe('Email');
    expect(CHAT_SCOPE_LABELS.sms).toBe('SMS');
  });

  it('a chat saved under an old name carries on as the combined one', () => {
    for (const old of ['bulk_email', 'ai_email_drafts', 'email_automations']) expect(parseChatScope(old)).toBe('email');
    for (const old of ['bulk_sms', 'sms_automations']) expect(parseChatScope(old)).toBe('sms');
  });

  it('old saved chats are still found by a filter on what can be opened', () => {
    expect(STORED_OPEN_CHAT_SCOPES).toEqual(expect.arrayContaining(['email', 'bulk_email', 'ai_email_drafts', 'email_automations', 'sms', 'bulk_sms', 'sms_automations']));
  });

  it('the three email skills open the Email chat, the two SMS skills the SMS chat', () => {
    for (const k of ['bulk_email', 'ai_email_drafts', 'workflow_emails', 'email']) expect(chatScopeOfSkill(k), k).toBe('email');
    for (const k of ['bulk_sms', 'workflow_texts', 'sms']) expect(chatScopeOfSkill(k), k).toBe('sms');
  });

  it('missed call text and AI call back are left alone: no chat', () => {
    expect(chatScopeOfSkill('missed_call_text')).toBeNull();
    expect(chatScopeOfSkill('ai_callback')).toBeNull();
  });

  it('Email can send, draft, schedule and build, and never text', () => {
    const tools = CHAT_SCOPE_RULES.email.tools as readonly string[];
    for (const t of ['send_template_email', 'send_email', 'create_template', 'create_workflow', 'change_workflow', 'create_automation']) expect(tools, t).toContain(t);
    expect(tools).not.toContain('send_template_sms');
    expect(chatScopeRefusal('email', 'create_workflow', { actions: [{ type: 'send_template_sms' }] })).not.toBeNull();
    expect(chatScopeRefusal('email', 'create_workflow', { actions: [{ type: 'send_template_email' }] })).toBeNull();
  });

  it('SMS can text, schedule and build, and never email', () => {
    const tools = CHAT_SCOPE_RULES.sms.tools as readonly string[];
    for (const t of ['send_template_sms', 'create_workflow', 'change_workflow', 'create_automation']) expect(tools, t).toContain(t);
    for (const t of ['send_template_email', 'send_email', 'create_template']) expect(tools, t).not.toContain(t);
    expect(chatScopeRefusal('sms', 'create_workflow', { actions: [{ type: 'send_template_email' }] })).not.toBeNull();
    expect(chatScopeRefusal('sms', 'create_workflow', { actions: [{ type: 'draft_email' }] })).not.toBeNull();
    expect(chatScopeRefusal('sms', 'create_workflow', { actions: [{ type: 'send_template_sms' }] })).toBeNull();
  });

  it('each lists only its own templates', () => {
    expect(templateChannel('email', 'sms')).toBe('email');
    expect(templateChannel('sms', 'email')).toBe('sms');
  });

  it('each action still answers to its own switch underneath', () => {
    expect(chatScopeSkillFor('email', 'send_template_email')).toBe('bulk_email');
    expect(chatScopeSkillFor('email', 'create_template')).toBe('bulk_email');
    expect(chatScopeSkillFor('email', 'send_email')).toBe('ai_email_drafts');
    expect(chatScopeSkillFor('email', 'create_workflow')).toBe('workflow_emails');
    expect(chatScopeSkillFor('sms', 'send_template_sms')).toBe('bulk_sms');
    expect(chatScopeSkillFor('sms', 'create_workflow')).toBe('workflow_texts');
  });

  it('groups an automation’s chat under the combined skill', () => {
    expect(skillKeyOfChatScope('email')).toBe('email');
    expect(skillKeyOfChatScope('bulk_sms')).toBe('sms');
    expect(skillKeyOfChatScope('listing_copy')).toBe('ai_listing_copy');
    expect(skillKeyOfChatScope(null)).toBeNull();
  });
});

describe('starting one', () => {
  const db = (enabledFor: string[]) =>
    ({
      select: () => {
        let calls = 0;
        return { from: () => ({ where: () => ({ limit: async () => [{ enabled: enabledFor.length > calls++ && Boolean(enabledFor[0]) }], then: undefined }) }) };
      },
      insert: () => ({ values: () => ({ returning: async () => [{ id: 'c1' }] }) }),
    }) as unknown as Db;

  it('starts while any of its skills is on', async () => {
    expect((await claimTurn(db(['bulk_email']), actor, { message: 'hi', surface: 'agency', chatScope: 'email' })).chatScope).toBe('email');
  });
  it('is refused while none is', async () => {
    await expect(claimTurn(db([]), actor, { message: 'hi', surface: 'agency', chatScope: 'email' })).rejects.toThrow('switched off');
  });
});
