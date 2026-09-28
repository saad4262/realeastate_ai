import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { getModel, isPricedModel } from '../models';
import { ALERT_SUMMARY_V1 } from '../prompts/alert-summary-v1';
import {
  findFigures,
  writeAlertSummary,
  type AlertSummaryFacts,
  type WriteAlertSummaryInput,
} from './alert-summary';

const FACTS: AlertSummaryFacts = {
  description: '3+ bed homes to rent in Pakenham',
  matched: 12,
  newCount: 2,
  listings: [
    { headline: 'Near the reserve', address: '12 Example St, Pakenham VIC', price: '$700 a week', specs: '3 bed' },
  ],
};

/**
 * A stand-in for `client.messages.create` that records the params it was
 * given — which is the whole point. ARCHITECTURE § 12: a model swap broke
 * /chat completely while 99 unit tests stayed green, because nothing built a
 * request and looked at it.
 */
function fakeClient(text: string) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params);
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: 400, output_tokens: 40 },
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;

  return { client, calls };
}

async function run(text: string) {
  const { client, calls } = fakeClient(text);
  const track = vi.fn(async (_row: Parameters<WriteAlertSummaryInput['track']>[0]) => {});

  const result = await writeAlertSummary({
    apiKey: 'unused-because-a-client-was-injected',
    client,
    facts: FACTS,
    track,
    runId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
  });

  return { result, calls, track };
}

describe('writeAlertSummary', () => {
  it('returns the model paragraph when it contains no figures', async () => {
    const { result } = await run('Two back onto the reserve, and one has the extra bedroom.');
    // "Two" is a written-out count and must be rejected — see below. Use a
    // genuinely figure-free sentence for the happy path.
    expect(result.source).toBe('template');

    const clean = await run('These back onto the reserve, and the last has an extra bedroom.');
    expect(clean.result).toEqual({
      source: 'model',
      text: 'These back onto the reserve, and the last has an extra bedroom.',
    });
  });

  /**
   * The fourth and last layer of #4. The first three are structural — no
   * numbers in the input, no tools on the request, every figure rendered by
   * the template — and this is the one that catches the model doing it
   * anyway. Break `findFigures` and this test is what goes red.
   */
  it('rejects a paragraph that states a price', async () => {
    const { result } = await run('The cheapest is $780,000, which is under your budget.');
    expect(result.source).toBe('template');
    expect(result.text).toBeNull();
  });

  it('rejects digits, written-out counts and percentages alike', async () => {
    for (const text of [
      'There are 3 new homes.',
      'Three of them are near the station.',
      'Prices are 5 per cent lower.',
      'One is a townhouse.',
    ]) {
      const { result } = await run(text);
      expect(result.source, text).toBe('template');
    }
  });

  it('rejects an empty answer rather than sending a blank paragraph', async () => {
    const { result } = await run('   ');
    expect(result).toMatchObject({ source: 'template', rejected: 'empty' });
  });

  /**
   * Layer two, asserted on the recorded request: the model has no tool to
   * call, so it cannot look anything up even if it wanted to. `tools` must
   * be ABSENT, not an empty array.
   */
  it('sends no tools at all', async () => {
    const { calls } = await run('Nothing remarkable about this batch.');
    expect(calls[0]).not.toHaveProperty('tools');
    expect(calls[0]).not.toHaveProperty('tool_choice');
  });

  it('sends the frozen prompt, a small token budget, and no thinking', async () => {
    const { calls } = await run('Nothing remarkable about this batch.');
    const params = calls[0] as Record<string, unknown>;

    expect(params.max_tokens).toBe(400);
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('effort');

    const system = params.system as { text: string }[];
    expect(system[0]?.text).toBe(ALERT_SUMMARY_V1);
  });

  /** #5 — a date in the system block breaks prompt caching on every request. */
  it('puts no date in the system block', async () => {
    const { calls } = await run('Nothing remarkable about this batch.');
    const system = (calls[0] as { system: { text: string }[] }).system;
    expect(system[0]?.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(system[0]?.text).not.toMatch(/\b20\d\d\b/);
  });

  /**
   * #3 — the call cost money, so there is a row for it even when the answer
   * is thrown away for containing a figure.
   */
  it('meters the call even when the answer is rejected', async () => {
    const { track } = await run('The cheapest is $780,000.');
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]?.[0]).toMatchObject({
      entityId: '11111111-1111-1111-1111-111111111111',
      userId: '22222222-2222-2222-2222-222222222222',
    });
  });

  it('hands the model no bare integers to work from', async () => {
    const { calls } = await run('Nothing remarkable about this batch.');
    const message = (calls[0] as { messages: { content: string }[] }).messages[0]?.content ?? '';

    // The counts travel as words; the prices travel preformatted.
    expect(message).toContain('several new listings');
    expect(message).not.toContain('12');
    expect(message).not.toMatch(/matched|newCount/);
  });
});

describe('findFigures', () => {
  it('passes prose with no figures in it', () => {
    expect(findFigures('These back onto the reserve and feel quiet.')).toBeNull();
  });

  it('names what it found, so a rejection is debuggable', () => {
    expect(findFigures('About $700 a week')).toContain('dollar sign');
    expect(findFigures('Around 700 a week')).toContain('digit');
  });
});

describe('the alert-summary model', () => {
  /**
   * `costUsd` looks its price up by exact id and returns 0 for anything it
   * does not know, so a dated snapshot here would silently write $0 into
   * every ai_run row while everything appeared to work — and the spend
   * budget reads those rows.
   */
  it('is a priced alias, not a dated snapshot', () => {
    expect(isPricedModel(getModel('alert-summary').id)).toBe(true);
  });

  it('asks for far fewer tokens than the chat', () => {
    expect(getModel('alert-summary').maxTokens).toBeLessThan(getModel('property-chat').maxTokens);
  });
});
