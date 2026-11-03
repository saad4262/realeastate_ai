import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { planDraftSchema, RENOVATION_FEATURE, RENOVATION_ROOMS_FEATURE, type RenovationPlanner, type RoomReader } from '@repo/core/renovation';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { RENOVATION_PLAN_SYSTEM, RENOVATION_PROMPT_VERSION, RENOVATION_ROOMS_SYSTEM } from '../prompts/renovation-v1';

/**
 * The model calls behind Renovation AI (ADR 0080, C3): the plan (words → kinds of work) and the rooms in a
 * listing's photos. One request each, no tools, the summary tier, metered to `ai_run` (#3). The plan's shape is
 * checked by zod here; core checks its content (`checkPlan`) and the rooms' strict schema after (#4).
 */

export type RenovationDeps = {
  apiKey: string;
  db: Db;
  /** Test seam: a fake client never reaches the network. */
  client?: Anthropic;
  env?: NodeJS.ProcessEnv;
};

function usageOf(response: Anthropic.Message): TokenUsage {
  return {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
    ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
  };
}

function jsonOf(response: Anthropic.Message): unknown {
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') throw new Error('The model did not answer');
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The answer was not in the expected shape');
  }
}

export function createRenovationPlanner(deps: RenovationDeps): RenovationPlanner {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async (input) => {
    const model = getModel('skill-summary', deps.env);
    const startedAt = Date.now();
    const rooms = input.rooms.length ? `ROOMS IN THE PHOTOS: ${input.rooms.join(', ')}\n\n` : '';
    const response = await client.messages.create({
      model: model.id,
      max_tokens: Math.min(model.maxTokens, 800),
      system: [{ type: 'text', text: RENOVATION_PLAN_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `${rooms}WHAT THEY WOULD CHANGE:\n${input.request}` }],
    });
    await trackAiRunQuietly(deps.db, { feature: RENOVATION_FEATURE, model: model.id, usage: usageOf(response), latencyMs: Date.now() - startedAt, promptVersion: RENOVATION_PROMPT_VERSION });
    const out = planDraftSchema.safeParse(jsonOf(response));
    if (!out.success) throw new Error('The plan was not in the expected shape');
    return out.data;
  };
}

/** Returns the model's answer unparsed: core applies the strict room schema, so a word about condition refuses it whole. */
export function createRoomReader(deps: RenovationDeps): RoomReader {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async (input) => {
    const model = getModel('skill-summary', deps.env);
    const startedAt = Date.now();
    const content: Anthropic.ContentBlockParam[] = input.photoUrls.flatMap((url, i) => [
      { type: 'text' as const, text: `Photo ${i + 1}:` },
      { type: 'image' as const, source: { type: 'url' as const, url } },
    ]);
    const response = await client.messages.create({
      model: model.id,
      max_tokens: Math.min(model.maxTokens, 500),
      system: [{ type: 'text', text: RENOVATION_ROOMS_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    });
    await trackAiRunQuietly(deps.db, { feature: RENOVATION_ROOMS_FEATURE, model: model.id, usage: usageOf(response), latencyMs: Date.now() - startedAt, promptVersion: RENOVATION_PROMPT_VERSION });
    return jsonOf(response) as ReturnType<RoomReader> extends Promise<infer T> ? T : never;
  };
}

/** Both, for this server — or null without a key (or with CONSUMER_AI=off); then the page says the AI is unavailable. */
export function renovationAiFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): { planner: RenovationPlanner; rooms: RoomReader } | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.CONSUMER_AI?.trim().toLowerCase() === 'off') return null;
  return { planner: createRenovationPlanner({ apiKey, db, env }), rooms: createRoomReader({ apiKey, db, env }) };
}

export { RENOVATION_PROMPT_VERSION };
