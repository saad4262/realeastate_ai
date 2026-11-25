import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { SEARCH_UNDERSTAND_FEATURE, type SearchUnderstander } from '@repo/core/listings/url';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { SEARCH_UNDERSTAND_PROMPT_VERSION, SEARCH_UNDERSTAND_SYSTEM } from '../prompts/search-understand-v2';

/**
 * The model call behind smart search (ADR 0101): one short request, no tools, metered to `ai_run` (#3). It returns
 * the parsed JSON as it came; core's `verifyUnderstood` decides what of it may be used.
 */

export type SearchUnderstanderDeps = { apiKey: string; db: Db; client?: Anthropic; env?: NodeJS.ProcessEnv };

export function createSearchUnderstander(deps: SearchUnderstanderDeps): SearchUnderstander {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async ({ text }) => {
    // The summary tier: reading a sentence into fields is classification, not reasoning.
    const model = getModel('skill-summary', deps.env);
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: model.id,
      max_tokens: Math.min(model.maxTokens, 400),
      system: [{ type: 'text', text: SEARCH_UNDERSTAND_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `TEXT:\n${text}` }],
    });
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
      ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
    };
    // Public and anonymous: no user or agency on the row, so it counts against the public share of the budget.
    await trackAiRunQuietly(deps.db, {
      feature: SEARCH_UNDERSTAND_FEATURE,
      model: model.id,
      usage,
      latencyMs: Date.now() - startedAt,
      promptVersion: SEARCH_UNDERSTAND_PROMPT_VERSION,
    });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') throw new Error('The model did not answer');
    const answer = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
      return JSON.parse(answer) as unknown;
    } catch {
      throw new Error('The answer was not in the expected shape');
    }
  };
}

/** The understander for this server, or null without a key (or with SEARCH_AI=off): then the box uses the rules alone. */
export function searchUnderstanderFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): SearchUnderstander | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.SEARCH_AI?.trim().toLowerCase() === 'off') return null;
  return createSearchUnderstander({ apiKey, db, env });
}

export { SEARCH_UNDERSTAND_PROMPT_VERSION };
