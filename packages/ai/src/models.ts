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

/**
 * Which request parameters a model will actually accept.
 *
 * This is not a nicety. `output_config: { effort }` and
 * `thinking: { type: 'adaptive' }` are both rejected with HTTP 400
 * invalid_request_error by a model that does not implement them — "This model
 * does not support the effort parameter" and "adaptive thinking is not
 * supported on this model". There is no degraded mode: the turn simply fails,
 * and on this route that is a visitor watching "Something went wrong reaching
 * the assistant".
 *
 * Verified against the live API on 2026-09-25, one 1-token request per model
 * per parameter. Opus 5 and Sonnet 5 accept both. Haiku 4.5 accepts neither.
 *
 * An id that is not listed is treated as accepting nothing, which is the safe
 * direction: omitting a parameter a model would have honoured costs some
 * answer quality, while sending one it rejects costs the whole turn.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

type Capabilities = {
  effort: boolean;
  adaptiveThinking: boolean;
};

const CAPABILITIES: Readonly<Record<string, Capabilities>> = Object.freeze({
  'claude-opus-5': { effort: true, adaptiveThinking: true },
  'claude-sonnet-5': { effort: true, adaptiveThinking: true },
  'claude-haiku-4-5': { effort: false, adaptiveThinking: false },
});

const NO_CAPABILITIES: Capabilities = { effort: false, adaptiveThinking: false };

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
   *
   * NOTE: that measurement was taken against Opus, and the model has since
   * moved to Haiku for cost — which does not accept this parameter at all, so
   * on the current default it is absent rather than lowered. Nothing has re-run
   * those cases against Haiku. A smaller model with no reasoning budget is more
   * likely to make those mistakes, not less. If the guide starts sending
   * filters nobody asked for again, this is the first thing to look at, and the
   * fix is a measurement rather than a guess.
   *
   * Undefined when the chosen model rejects the parameter — see CAPABILITIES.
   * The pipeline omits `output_config` entirely in that case; it must never
   * send a default in its place.
   */
  effort?: Effort;
  /**
   * Whether to ask for `thinking: { type: 'adaptive' }`.
   *
   * Same story as `effort`: a model without it rejects the whole request, so
   * this is a capability of the id rather than a preference of the route.
   */
  adaptiveThinking: boolean;
};

/**
 * Haiku, for cost. Opus was overkill for choosing filters out of a sentence
 * and was draining the balance on a public, unauthenticated route.
 *
 * The id is the ALIAS, not a dated snapshot, and that is load-bearing: costUsd
 * looks the price up by exact id and returns 0 for anything it does not know,
 * so `claude-haiku-4-5-20251001` would have silently written $0 into every
 * ai_run row while the chat carried on working. `modelIsPriced` below is the
 * test that refuses that.
 *
 * Roughly a fifth of Opus per input token and a fifth per output token — see
 * PRICES above.
 */
const DEFAULT_CHAT_MODEL = 'claude-haiku-4-5';

/** Used only by models that accept it. See ModelChoice.effort for the measurement. */
const CHAT_EFFORT: Effort = 'medium';

/** Model router. One feature today; the shape is what M3 grows into. */
export function getModel(feature: AiFeature, env: NodeJS.ProcessEnv = process.env): ModelChoice {
  switch (feature) {
    case 'property-chat': {
      const id = env.ANTHROPIC_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
      const can = CAPABILITIES[id] ?? NO_CAPABILITIES;
      return {
        id,
        maxTokens: 4096,
        // Spread rather than `effort: can.effort ? CHAT_EFFORT : undefined`, so
        // the key is genuinely absent. `exactOptionalPropertyTypes` aside, an
        // explicit `undefined` is what a JSON body serialises away anyway — but
        // absent is the thing being asserted, so make it absent.
        ...(can.effort ? { effort: CHAT_EFFORT } : {}),
        adaptiveThinking: can.adaptiveThinking,
      };
    }
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
