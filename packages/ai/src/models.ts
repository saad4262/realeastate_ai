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
   * Adaptive thinking spends this budget too, so it is headroom rather than a
   * cost ceiling — an under-sized max_tokens truncates an answer mid-thought,
   * it does not make a turn cheaper. What a turn actually costs is governed by
   * `effort` and by the three-round tool cap.
   */
  maxTokens: number;
  /**
   * Medium, and the number is a measurement rather than a preference.
   *
   * This started at `low`, reasoning that a consumer chat is latency-sensitive
   * and the work is only choosing filters. Against the real model that was
   * wrong in a way no unit test could show: at `low` the guide sent
   * `priceTo: 0` on a message with no budget in it, put a stray `x` in the
   * keyword field, missed "under 30km" entirely, and on one turn emitted
   * "ację / comment / Let me run that properly" before recovering. Choosing
   * filters from a sentence IS the reasoning here, and starving it produced a
   * guide that searched confidently for the wrong thing.
   *
   * Raise to `high` only against another measurement.
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
        maxTokens: 4096,
        effort: 'medium',
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
