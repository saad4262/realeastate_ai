/**
 * Which model answers which feature, and what that costs.
 *
 * The price table is written down rather than fetched because an ai_run row is
 * a record of what was spent at the time it was spent. A cost recomputed later
 * from a live price list would quietly rewrite last month's numbers.
 */

/** USD per million tokens. Cache reads are a tenth; a cache write is a quarter more. */
type Price = {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWriteMultiplier: number;
  cacheReadMultiplier: number;
};

const PRICES: Readonly<Record<string, Price>> = Object.freeze({
  'claude-opus-5': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
  'claude-sonnet-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
  'claude-haiku-4-5': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
  },
});

export type AiFeature = 'property-chat';

export type ModelChoice = {
  id: string;
  /**
   * Conversational turns are short, and every figure in them comes from a tool
   * result rather than from prose. 2048 is room to spare; it is also the cost
   * ceiling for a single turn on an anonymous public page.
   */
  maxTokens: number;
  /**
   * Low, deliberately. This is a latency-sensitive consumer route where the
   * work is choosing filters, not reasoning hard — and the numbers are SQL's
   * either way. Raise it only against a measurement.
   */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

const DEFAULT_CHAT_MODEL = 'claude-opus-5';

/** Model router. One feature today; the shape is what M3 grows into. */
export function getModel(feature: AiFeature, env: NodeJS.ProcessEnv = process.env): ModelChoice {
  switch (feature) {
    case 'property-chat':
      return {
        id: env.ANTHROPIC_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL,
        maxTokens: 2048,
        effort: 'low',
      };
    default: {
      // Exhaustiveness: a new feature with no entry is a compile error, not a
      // silent fall through to whatever model happened to be first.
      const never: never = feature;
      throw new Error(`No model configured for feature: ${String(never)}`);
    }
  }
}

/** What the API reports back about one request. */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

/**
 * What one request cost, in USD.
 *
 * Cached tokens are billed differently from fresh ones, and on this route most
 * of the prompt is cached by design — counting them at the full input rate
 * would overstate the bill by roughly an order of magnitude and hide whether
 * the caching is working at all.
 *
 * An unknown model returns 0 rather than throwing: a price table that has not
 * caught up with a model swap should not take down the chat.
 */
export function costUsd(modelId: string, usage: TokenUsage): number {
  const price = PRICES[modelId];
  if (!price) return 0;

  const million = 1_000_000;
  const fresh = usage.inputTokens * price.inputPerMTok;
  const written =
    (usage.cacheCreationInputTokens ?? 0) * price.inputPerMTok * price.cacheWriteMultiplier;
  const read = (usage.cacheReadInputTokens ?? 0) * price.inputPerMTok * price.cacheReadMultiplier;
  const out = usage.outputTokens * price.outputPerMTok;

  return (fresh + written + read + out) / million;
}

/** Whether a price is known, so a caller can say "not metered" rather than "$0". */
export function isPricedModel(modelId: string): boolean {
  return modelId in PRICES;
}
