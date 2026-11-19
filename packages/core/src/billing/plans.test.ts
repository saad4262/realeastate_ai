import { describe, expect, it } from 'vitest';
import { SKILL_KEYS } from '../skill-switches/catalog';
import { PAID_PLANS, PLAN_SKILLS, planAllowsSkill, planNumbers } from './plans';

/** ADR 0092 / PLATFORM-PLAN 2.2: the plan map. */
describe('the plan map', () => {
  it('each plan includes the one below it', () => {
    for (const k of PLAN_SKILLS.starter) expect(PLAN_SKILLS.growth.has(k), k).toBe(true);
    for (const k of PLAN_SKILLS.growth) expect(PLAN_SKILLS.pro.has(k), k).toBe(true);
  });

  it('Pro allows every skill in the catalog; a new skill must be placed in a plan', () => {
    expect([...SKILL_KEYS].filter((k) => !PLAN_SKILLS.pro.has(k))).toEqual([]);
  });

  it('a paid plan refuses what it does not include', () => {
    expect(planAllowsSkill('starter', 'bulk_email')).toBe(true);
    expect(planAllowsSkill('starter', 'bulk_sms')).toBe(false);
    expect(planAllowsSkill('growth', 'bulk_sms')).toBe(true);
    expect(planAllowsSkill('growth', 'ai_callback')).toBe(false);
    expect(planAllowsSkill('pro', 'ai_callback')).toBe(true);
  });

  it('trial, an old admin-typed plan name or none: every skill (nobody loses one before buying a plan)', () => {
    for (const plan of ['trial', 'Enterprise (manual)', null, undefined, '']) {
      expect(SKILL_KEYS.every((k) => planAllowsSkill(plan, k)), String(plan)).toBe(true);
    }
  });
});

describe('planNumbers', () => {
  it('reads credits, seats and the Stripe Price ID from env; never guesses', () => {
    const env = { PLAN_GROWTH_CREDITS: '3000', PLAN_GROWTH_SEATS: '3', STRIPE_PRICE_GROWTH: ' price_123 ' } as unknown as NodeJS.ProcessEnv;
    expect(planNumbers('growth', env)).toEqual({ credits: 3000, seats: 3, stripePriceId: 'price_123' });
    expect(planNumbers('pro', env)).toEqual({ credits: null, seats: null, stripePriceId: null });
    expect(planNumbers('starter', { PLAN_STARTER_CREDITS: '1,000', PLAN_STARTER_SEATS: '-1' } as unknown as NodeJS.ProcessEnv)).toEqual({ credits: null, seats: null, stripePriceId: null });
  });

  it('knows exactly three paid plans', () => {
    expect([...PAID_PLANS]).toEqual(['starter', 'growth', 'pro']);
  });
});
