import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { FLOORPLAN_FEATURE, type FloorplanReader } from '@repo/core/media';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { FLOORPLAN_PROMPT_VERSION, FLOORPLAN_SYSTEM } from '../prompts/floorplan-v1';

/**
 * The model behind a floorplan's room names (ADR 0080, C9 decision 3): one image, no tools, the summary tier, metered
 * to `ai_run` (#3). Returns the answer unparsed — core's strict schema decides, so a size or a count refuses it whole.
 */
export type FloorplanDeps = { apiKey: string; db: Db; client?: Anthropic; env?: NodeJS.ProcessEnv };

export function createFloorplanReader(deps: FloorplanDeps): FloorplanReader {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async ({ imageUrl }) => {
    const model = getModel('skill-summary', deps.env);
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: model.id,
      max_tokens: Math.min(model.maxTokens, 300),
      system: [{ type: 'text', text: FLOORPLAN_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: imageUrl } }, { type: 'text', text: 'The floorplan.' }] }],
    });
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
      ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
    };
    await trackAiRunQuietly(deps.db, { feature: FLOORPLAN_FEATURE, model: model.id, usage, latencyMs: Date.now() - startedAt, promptVersion: FLOORPLAN_PROMPT_VERSION });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') throw new Error('The model did not answer');
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { unreadable: true };
    }
  };
}

/** The reader for this server, or null without a key (or with CONSUMER_AI=off): floorplans then show without room names. */
export function floorplanReaderFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): FloorplanReader | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.CONSUMER_AI?.trim().toLowerCase() === 'off') return null;
  return createFloorplanReader({ apiKey, db, env });
}

export { FLOORPLAN_PROMPT_VERSION };
