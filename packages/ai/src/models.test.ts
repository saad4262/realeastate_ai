import { describe, expect, it } from 'vitest';
import { costUsd, getModel, isPricedModel } from './models';

/**
 * The guard that makes a model swap safe.
 *
 * costUsd looks the price up by EXACT model id and returns 0 for anything it
 * does not recognise — deliberately, so a price table that has not caught up
 * cannot take down the chat. The cost of that kindness is that a typo, or a
 * dated snapshot id like `claude-haiku-4-5-20251001` where the table holds the
 * alias `claude-haiku-4-5`, writes $0 into every ai_run row while the chat
 * carries on working perfectly. Nothing would ever go red.
 *
 * So the thing to assert is not what the model IS — that is a product decision
 * and changing it should not break a test — but that whatever it is, it is
 * priced.
 */
describe('every configured model is priced', () => {
  const features = ['property-chat'] as const;

  it.each(features)('%s resolves to a model the price table knows', (feature) => {
    const { id } = getModel(feature, {} as NodeJS.ProcessEnv);
    expect(isPricedModel(id)).toBe(true);
  });

  it('prices an env override too, or refuses to pretend it is free', () => {
    // ANTHROPIC_CHAT_MODEL is the escape hatch for swapping models without a
    // deploy. It is also the easiest way to start recording $0 by accident.
    const override = { ANTHROPIC_CHAT_MODEL: 'claude-sonnet-5' } as NodeJS.ProcessEnv;
    expect(isPricedModel(getModel('property-chat', override).id)).toBe(true);

    const unknown = { ANTHROPIC_CHAT_MODEL: 'claude-haiku-4-5-20251001' } as NodeJS.ProcessEnv;
    expect(isPricedModel(getModel('property-chat', unknown).id)).toBe(false);
  });

  it('bills a real turn at more than nothing', () => {
    // The end of the same rope: a priced model must produce a non-zero cost
    // for non-zero usage, or the metering is decorative.
    const { id } = getModel('property-chat', {} as NodeJS.ProcessEnv);
    const cost = costUsd(id, {
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(cost).toBeGreaterThan(0);
  });
});

describe('the model choice itself', () => {
  it('keeps the headroom and the effort the route was tuned for', () => {
    const choice = getModel('property-chat', {} as NodeJS.ProcessEnv);
    // maxTokens is headroom, not a cost ceiling — adaptive thinking spends it
    // too, and an undersized value truncates an answer rather than saving money.
    expect(choice.maxTokens).toBe(4096);
    expect(choice.effort).toBe('medium');
  });
});
