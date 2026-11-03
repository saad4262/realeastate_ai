import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Db } from '@repo/db';
import { RESEARCH_FEATURE, type ResearchWriter } from '@repo/core/research';
import type { AssistRecord } from '@repo/core/due-diligence';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { RESEARCH_PROMPT_VERSION, RESEARCH_SYSTEM } from '../prompts/research-v1';

/**
 * The model call behind C5's paragraphs (ADR 0080): one request, no tools, the summary tier, metered to `ai_run` (#3).
 * Shape by zod here; references, figures and the verdict rule by core after (#4).
 */
const line = z.object({ text: z.string().trim().min(1).max(400), refs: z.array(z.string().trim().min(1).max(8)).min(1).max(10) }).strict();
const answerSchema = z.object({ lines: z.array(line).max(10) }).strict();

export type ResearchDeps = { apiKey: string; db: Db; client?: Anthropic; env?: NodeJS.ProcessEnv };

export function recordsBlock(records: readonly AssistRecord[]): string {
  return records.map((r) => `[${r.ref}] ${r.text}`).join('\n');
}

export function createResearchWriter(deps: ResearchDeps): ResearchWriter {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async (input) => {
    const model = getModel('skill-summary', deps.env);
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: model.id,
      max_tokens: Math.min(model.maxTokens, 800),
      system: [{ type: 'text', text: RESEARCH_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `KIND: ${input.kind}\nABOUT: ${input.subject}\n\nRECORDS:\n${recordsBlock(input.records)}` }],
    });
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
      ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
    };
    await trackAiRunQuietly(deps.db, { feature: RESEARCH_FEATURE, model: model.id, usage, latencyMs: Date.now() - startedAt, promptVersion: RESEARCH_PROMPT_VERSION });
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
export function researchWriterFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): ResearchWriter | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.CONSUMER_AI?.trim().toLowerCase() === 'off') return null;
  return createResearchWriter({ apiKey, db, env });
}

export { RESEARCH_PROMPT_VERSION };
