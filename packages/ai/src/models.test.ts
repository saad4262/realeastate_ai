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
  it('keeps the headroom the route was tuned for', () => {
    const choice = getModel('property-chat', {} as NodeJS.ProcessEnv);
    // maxTokens is headroom, not a cost ceiling — thinking spends it too, and
    // an undersized value truncates an answer rather than saving money.
    expect(choice.maxTokens).toBe(4096);
  });
});

/**
 * The second way a model swap breaks silently — except this one is not silent
 * at all, it is a hard HTTP 400 on every turn, which is worse in production and
 * invisible in a test suite that never builds a request.
 *
 * `output_config: { effort }` and `thinking: { type: 'adaptive' }` are rejected
 * outright by a model that does not implement them. Haiku 4.5 rejects both. The
 * move to Haiku therefore broke /chat completely, and nothing here noticed,
 * because every test either called getModel (which is happy to report an effort
 * nobody can send) or used a fake client (which accepts any params at all).
 *
 * So: assert the capability table agrees with the live API, and — in
 * property-chat.test.ts — assert the request body actually omits them.
 */
describe('parameters are only claimed where the model accepts them', () => {
  it('asks for neither knob on Haiku, which rejects both', () => {
    const choice = getModel('property-chat', {
      ANTHROPIC_CHAT_MODEL: 'claude-haiku-4-5',
    } as NodeJS.ProcessEnv);
    expect(choice.effort).toBeUndefined();
    expect(choice.adaptiveThinking).toBe(false);
  });

  it.each(['claude-opus-5', 'claude-sonnet-5'])('asks for both on %s, which accepts both', (id) => {
    const choice = getModel('property-chat', {
      ANTHROPIC_CHAT_MODEL: id,
    } as NodeJS.ProcessEnv);
    expect(choice.effort).toBe('medium');
    expect(choice.adaptiveThinking).toBe(true);
  });

  it('claims nothing for a model it has never heard of', () => {
    // The safe direction. Omitting a parameter the model would have honoured
    // costs some answer quality; sending one it rejects costs the whole turn,
    // and an unrecognised id is exactly the case where we cannot know.
    const choice = getModel('property-chat', {
      ANTHROPIC_CHAT_MODEL: 'claude-something-7',
    } as NodeJS.ProcessEnv);
    expect(choice.effort).toBeUndefined();
    expect(choice.adaptiveThinking).toBe(false);
  });

  it('leaves the key absent rather than present-and-undefined', () => {
    // A JSON body drops an undefined value anyway, so this is belt and braces —
    // but `effort` in choice is the thing the pipeline branches on, and a key
    // that exists with an undefined value is a different shape from no key.
    const choice = getModel('property-chat', {} as NodeJS.ProcessEnv);
    expect('effort' in choice).toBe(false);
  });
});

describe('skill tiers (ADR 0021)', () => {
  it('defaults each tier to the model the plan names, every one of them priced', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(getModel('skill-summary', env).id).toBe('claude-haiku-4-5');
    expect(getModel('skill-agent', env).id).toBe('claude-sonnet-5-5');
    expect(getModel('skill-hard', env).id).toBe('claude-opus-5-5');
    for (const f of ['skill-summary', 'skill-agent', 'skill-hard'] as const) {
      expect(isPricedModel(getModel(f, env).id)).toBe(true);
    }
  });

  it('is an env override, not a code change', () => {
    expect(getModel('skill-summary', { ANTHROPIC_SKILL_SUMMARY_MODEL: 'claude-sonnet-5-5' } as NodeJS.ProcessEnv).id).toBe('claude-sonnet-5-5');
  });

  it('never asks Haiku for effort or adaptive thinking, which it rejects', () => {
    const haiku = getModel('skill-summary', {} as NodeJS.ProcessEnv);
    expect(haiku.effort).toBeUndefined();
    expect(haiku.adaptiveThinking).toBe(false);
  });

  it('costs Sonnet 5.5 and Opus 5.5 at their published rates', () => {
    expect(costUsd('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(12);
    expect(costUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 1_000_000 })).toBeCloseTo(4.2); // $4 input + $0.20 cache hits (0.05x)
  });
});

/**
 * PLATFORM-PLAN 1.18: the table against the published prices (platform.claude.com/docs/en/about-claude/pricing,
 * read 2026-11-18), per million tokens: input, 5-minute cache write, cache hit, output. One million of each
 * kind costs exactly that.
 */
describe('prices match the published table', () => {
  const PUBLISHED: Record<string, { input: number; write: number; read: number; output: number }> = {
    'claude-opus-5-5': { input: 4, write: 5, read: 0.2, output: 20 },
    'claude-sonnet-5-5': { input: 2, write: 2.5, read: 0.1, output: 10 },
    'claude-opus-5': { input: 5, write: 6.25, read: 0.5, output: 25 },
    'claude-sonnet-5': { input: 2, write: 2.5, read: 0.2, output: 10 },
    'claude-haiku-4-5': { input: 1, write: 1.25, read: 0.1, output: 5 },
  };
  const M = 1_000_000;
  it.each(Object.entries(PUBLISHED))('%s', (id, p) => {
    expect(costUsd(id, { inputTokens: M, outputTokens: 0 })).toBeCloseTo(p.input, 6);
    expect(costUsd(id, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: M })).toBeCloseTo(p.write, 6);
    expect(costUsd(id, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: M })).toBeCloseTo(p.read, 6);
    expect(costUsd(id, { inputTokens: 0, outputTokens: M })).toBeCloseTo(p.output, 6);
  });
});
