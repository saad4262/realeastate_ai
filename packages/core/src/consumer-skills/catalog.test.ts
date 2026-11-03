import { describe, expect, it } from 'vitest';
import {
  CONSUMER_SKILL_GROUPS,
  CONSUMER_SKILL_KEYS,
  CONSUMER_SKILL_OF_TOOL,
  CONSUMER_SKILLS,
  consumerSkillBlock,
  consumerSkillDefault,
  consumerSkillOffMessage,
  isConsumerSkillKey,
  pausedConsumerSkills,
} from './catalog';

describe('the consumer skill catalog (ADR 0080)', () => {
  it('has the client’s 21 skills, each once, each in a known group', () => {
    expect(CONSUMER_SKILLS).toHaveLength(21);
    expect(CONSUMER_SKILLS.map((s) => s.key)).toEqual([...CONSUMER_SKILL_KEYS]);
    for (const s of CONSUMER_SKILLS) expect(CONSUMER_SKILL_GROUPS).toContain(s.group);
  });

  it('defaults a skill that answers to on and one that acts to off (the user, 2026-11-03)', () => {
    for (const s of CONSUMER_SKILLS) expect(consumerSkillDefault(s.key)).toBe(s.kind === 'answers');
    expect(consumerSkillDefault('smart_alerts')).toBe(true);
    expect(consumerSkillDefault('property_monitor')).toBe(false);
    expect(consumerSkillDefault('agent_messages')).toBe(false);
  });

  /** A visitor has no switch to turn an `acts` skill on with, so one that works signed out would be on by nobody's choice. */
  it('needs an account for every skill that acts', () => {
    for (const s of CONSUMER_SKILLS.filter((x) => x.kind === 'acts')) expect(s.account).toBe(true);
  });

  it('gives the reason a buyer can do nothing about first', () => {
    const none = new Set<never>();
    expect(consumerSkillBlock('comparison', true, true, none)).toBe('not_built');
    expect(consumerSkillBlock('smart_alerts', true, true, new Set(['smart_alerts'] as const))).toBe('paused');
    expect(consumerSkillBlock('smart_alerts', undefined, false, none)).toBe('needs_account');
    expect(consumerSkillBlock('smart_alerts', false, true, none)).toBe('switched_off');
    expect(consumerSkillBlock('smart_alerts', undefined, true, none)).toBeNull();
    expect(consumerSkillBlock('property_search', undefined, false, none)).toBeNull();
    expect(consumerSkillBlock('property_search', false, true, none)).toBe('switched_off');
  });

  it('reads the platform pause, ignoring what is not a skill', () => {
    expect([...pausedConsumerSkills({ CONSUMER_SKILLS_PAUSED: ' smart_alerts, nope ,buyer_assistant' })]).toEqual(['smart_alerts', 'buyer_assistant']);
    expect(pausedConsumerSkills({}).size).toBe(0);
  });

  it('gates chat tools only by skills that exist, and never the ways to stop something', () => {
    for (const key of Object.values(CONSUMER_SKILL_OF_TOOL)) expect(isConsumerSkillKey(key)).toBe(true);
    expect(CONSUMER_SKILL_OF_TOOL.cancel_schedule).toBeUndefined();
    expect(CONSUMER_SKILL_OF_TOOL.resolve_location).toBeUndefined();
  });

  it('says where to turn a skill back on', () => {
    expect(consumerSkillOffMessage('smart_alerts', 'switched_off')).toContain('My account → Skills');
    expect(consumerSkillOffMessage('smart_alerts', 'needs_account')).toContain('Sign in');
  });
});
