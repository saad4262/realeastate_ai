import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { PLATFORM_SKILLS, SKILL_COMBOS, comboOfSkill, isSkillCombo } from './catalog';
import { combineSkillViews, setSkillCombo, skillIsUsable, type SkillSwitchView } from './switches';

/** Email and SMS are one skill to the person; their parts keep their own switches underneath. */

const view = (key: string, on: boolean, over: object = {}) => ({ ...PLATFORM_SKILLS.find((s) => s.key === key)!, on, changedBy: null, changedAt: null, ...over }) as SkillSwitchView;
const all = (on: boolean) => PLATFORM_SKILLS.map((s) => view(s.key, on));

describe('the combined skills', () => {
  it('Email is the three email skills, SMS the two text skills', () => {
    expect(SKILL_COMBOS.find((c) => c.key === 'email')!.members).toEqual(['bulk_email', 'ai_email_drafts', 'workflow_emails']);
    expect(SKILL_COMBOS.find((c) => c.key === 'sms')!.members).toEqual(['bulk_sms', 'workflow_texts']);
  });
  it('knows a part from a whole', () => {
    expect(comboOfSkill('workflow_texts')?.key).toBe('sms');
    expect(comboOfSkill('missed_call_text')).toBeNull();
    expect(isSkillCombo('email')).toBe(true);
    expect(isSkillCombo('bulk_email')).toBe(false);
  });
  it('shows one card in place of its parts, in the same group', () => {
    const cards = combineSkillViews(all(true));
    const keys = cards.map((c) => c.key);
    expect(keys).toContain('email');
    expect(keys).toContain('sms');
    for (const k of ['bulk_email', 'ai_email_drafts', 'workflow_emails', 'bulk_sms', 'workflow_texts']) expect(keys).not.toContain(k);
    expect(cards.find((c) => c.key === 'email')!.group).toBe('Communication');
    expect(cards.find((c) => c.key === 'sms')!.group).toBe('Phone & SMS');
    expect(cards.length).toBe(PLATFORM_SKILLS.length - 3);
  });
  it('leaves missed call text and AI call back as they are', () => {
    const keys = combineSkillViews(all(true)).map((c) => c.key);
    expect(keys).toContain('missed_call_text');
    expect(keys).toContain('ai_callback');
  });
  it('is on only when every part is on', () => {
    const mixed = all(true).map((v) => (v.key === 'ai_email_drafts' ? { ...v, on: false } : v));
    expect(combineSkillViews(mixed).find((c) => c.key === 'email')!.on).toBe(false);
    expect(combineSkillViews(all(true)).find((c) => c.key === 'email')!.on).toBe(true);
  });
  it('for an agent SMS needs the agency’s switch on for every part', () => {
    const v = PLATFORM_SKILLS.filter((s) => s.scope === 'both').map((s) => view(s.key, true, s.key === 'bulk_sms' ? { agencyOn: true } : s.key === 'workflow_texts' ? { agencyOn: false } : {}));
    const sms = combineSkillViews(v).find((c) => c.key === 'sms')!;
    expect(sms.pair).toBe(true);
    expect(skillIsUsable(sms, 'personal')).toBe(false);
    expect(skillIsUsable(sms, 'agency')).toBe(true);
  });
  it('one switch flips every part, together', async () => {
    const execute = vi.fn(async () => []);
    const tx = { execute };
    const db = { transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as Db;
    const owner: Actor = { userId: 'u', agencyId: 'a', membershipRole: 'owner' };
    await setSkillCombo(db, owner, 'email', true);
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it('refuses a read-only member', async () => {
    const db = { transaction: async (fn: (t: unknown) => unknown) => fn({ execute: vi.fn() }) } as unknown as Db;
    await expect(setSkillCombo(db, { userId: 'u', agencyId: 'a', membershipRole: 'read_only' }, 'sms', true)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
