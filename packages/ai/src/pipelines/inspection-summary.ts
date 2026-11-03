import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Db } from '@repo/db';
import { INSPECTION_SUMMARY_FEATURE, type InspectionSummaryWriter } from '@repo/core/inspections';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { INSPECTION_SUMMARY_PROMPT_VERSION, INSPECTION_SUMMARY_SYSTEM } from '../prompts/inspection-summary-v1';
import { recordsBlock } from './research';

/**
 * The model call behind "Summarise my day" (ADR 0080, C6 decision 9): one request, no tools, the summary tier,
 * metered to `ai_run` (#3). It sees the buyer's marks and notes only — never a photo. Shape by zod here; references,
 * figures, the verdict rule and the condition rule by core after (#4).
 */
const line = z.object({ text: z.string().trim().min(1).max(400), refs: z.array(z.string().trim().min(1).max(8)).min(1).max(8) }).strict();
const answerSchema = z.object({ lines: z.array(line).max(12) }).strict();

export type InspectionSummaryDeps = { apiKey: string; db: Db; client?: Anthropic; env?: NodeJS.ProcessEnv };

export function createInspectionSummaryWriter(deps: InspectionSummaryDeps): InspectionSummaryWriter {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async (input) => {
    const model = getModel('skill-summary', deps.env);
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: model.id,
      max_tokens: Math.min(model.maxTokens, 900),
      system: [{ type: 'text', text: INSPECTION_SUMMARY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `RECORDS:\n${recordsBlock(input.records)}` }],
    });
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
      ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
    };
    await trackAiRunQuietly(deps.db, { feature: INSPECTION_SUMMARY_FEATURE, model: model.id, usage, latencyMs: Date.now() - startedAt, promptVersion: INSPECTION_SUMMARY_PROMPT_VERSION });
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
    const out = answerSchema.safeParse(raw);
    if (!out.success) throw new Error('The answer was not in the expected shape');
    return out.data;
  };
}

/** The writer for this server, or null without a key (or with CONSUMER_AI=off). */
export function inspectionSummaryWriterFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): InspectionSummaryWriter | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.CONSUMER_AI?.trim().toLowerCase() === 'off') return null;
  return createInspectionSummaryWriter({ apiKey, db, env });
}

export { INSPECTION_SUMMARY_PROMPT_VERSION };
