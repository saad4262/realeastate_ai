import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { LEAD_UNDERSTAND_FEATURE, rawUnderstandingSchema, type LeadUnderstander } from '@repo/core/leads';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { LEAD_UNDERSTAND_PROMPT_VERSION, LEAD_UNDERSTAND_SYSTEM } from '../prompts/lead-understand-v1';

/**
 * The model call behind "AI understands" (ADR 0078): one short request, no tools, metered to `ai_run` (#3). The
 * answer is shaped by core's schema here; core then keeps only the facts the enquiry really states.
 */

export type LeadUnderstanderDeps = { apiKey: string; db: Db; client?: Anthropic; env?: NodeJS.ProcessEnv };

export function createLeadUnderstander(deps: LeadUnderstanderDeps): LeadUnderstander {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async (input) => {
    const model = getModel('skill-agent', deps.env);
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: model.id,
      max_tokens: Math.min(model.maxTokens, 700),
      system: [{ type: 'text', text: LEAD_UNDERSTAND_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `TEXT:\n${input.text}` }],
    });
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
      ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
    };
    await trackAiRunQuietly(deps.db, {
      feature: LEAD_UNDERSTAND_FEATURE,
      model: model.id,
      usage,
      latencyMs: Date.now() - startedAt,
      userId: input.userId ?? undefined,
      agencyId: input.agencyId,
      promptVersion: LEAD_UNDERSTAND_PROMPT_VERSION,
    });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') throw new Error('The model did not answer');
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .replace(/^```(?:json)?\s*|\s*```$/g, '');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('The answer was not in the expected shape');
    }
    // Degrades field by field (an unknown intent is "not_sure"), never throws on a bad field.
    return rawUnderstandingSchema.parse(raw);
  };
}

/** The understander for this server, or null without a key (or with WORKFLOW_AI=off) — then leads are marked "off". */
export function leadUnderstanderFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): LeadUnderstander | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.WORKFLOW_AI?.trim().toLowerCase() === 'off') return null;
  return createLeadUnderstander({ apiKey, db, env });
}

export { LEAD_UNDERSTAND_PROMPT_VERSION };
