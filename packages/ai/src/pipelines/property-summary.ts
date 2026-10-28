import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Db } from '@repo/db';
import { PROPERTY_SUMMARY_FEATURE, type PropertyRecord, type PropertySummarizer } from '@repo/core/properties';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { PROPERTY_SUMMARY_PROMPT_VERSION, PROPERTY_SUMMARY_SYSTEM } from '../prompts/property-summary-v1';

/**
 * The model call behind a property's summary (ADR 0065): one request, no tools, metered to `ai_run` (#3),
 * the answer checked by zod here and by core after (citations, figures). Nothing is saved.
 */

const summarySchema = z
  .object({ points: z.array(z.object({ text: z.string().trim().min(1).max(400), refs: z.array(z.string().trim().min(1).max(8)).min(1).max(10) }).strict()).min(1).max(8) })
  .strict();

export type PropertySummaryDeps = {
  apiKey: string;
  db: Db;
  /** Test seam: a fake client never reaches the network. */
  client?: Anthropic;
  env?: NodeJS.ProcessEnv;
};

export function recordsBlock(records: PropertyRecord[]): string {
  return records.map((r) => `[${r.ref}] ${r.text}`).join('\n');
}

export function createPropertySummarizer(deps: PropertySummaryDeps): PropertySummarizer {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async (input) => {
    const model = getModel('skill-agent', deps.env);
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: model.id,
      max_tokens: Math.min(model.maxTokens, 1200),
      system: [{ type: 'text', text: PROPERTY_SUMMARY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `RECORDS:\n${recordsBlock(input.records)}` }],
    });
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
      ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
    };
    await trackAiRunQuietly(deps.db, {
      feature: PROPERTY_SUMMARY_FEATURE,
      model: model.id,
      usage,
      latencyMs: Date.now() - startedAt,
      userId: input.userId,
      agencyId: input.agencyId,
      promptVersion: PROPERTY_SUMMARY_PROMPT_VERSION,
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
    const out = summarySchema.safeParse(raw);
    if (!out.success) throw new Error('The summary was not in the expected shape');
    return out.data;
  };
}

/** The summarizer for this server, or null without a key (or with PROPERTY_AI=off) — then the panel says so. */
export function propertySummarizerFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): PropertySummarizer | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.PROPERTY_AI?.trim().toLowerCase() === 'off') return null;
  return createPropertySummarizer({ apiKey, db, env });
}

export { PROPERTY_SUMMARY_PROMPT_VERSION };
