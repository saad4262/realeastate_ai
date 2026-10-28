import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Db } from '@repo/db';
import { WORKFLOW_DECIDE_FEATURE, type WorkflowDecider } from '@repo/core/workflows';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { WORKFLOW_DECIDE_PROMPT_VERSION, WORKFLOW_DECIDE_SYSTEM } from '../prompts/workflow-decide-v1';

/**
 * The model call behind "AI decides" (ADR 0067): one short request, no tools, metered to `ai_run` (#3), the
 * answer shaped by zod here and checked against the workflow's own labels by core.
 */

const answerSchema = z.object({ choice: z.string().trim().min(1).max(60).nullable(), reason: z.string().trim().max(400) }).strict();

export type WorkflowDeciderDeps = { apiKey: string; db: Db; client?: Anthropic; env?: NodeJS.ProcessEnv };

export function createWorkflowDecider(deps: WorkflowDeciderDeps): WorkflowDecider {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async (input) => {
    const model = getModel('skill-agent', deps.env);
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: model.id,
      max_tokens: Math.min(model.maxTokens, 300),
      system: [{ type: 'text', text: WORKFLOW_DECIDE_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `QUESTION: ${input.question}\n\nCHOICES: ${JSON.stringify(input.choices)}\n\nTEXT:\n${input.text}` }],
    });
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
      ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
    };
    await trackAiRunQuietly(deps.db, {
      feature: WORKFLOW_DECIDE_FEATURE,
      model: model.id,
      usage,
      latencyMs: Date.now() - startedAt,
      userId: input.userId,
      agencyId: input.agencyId,
      promptVersion: WORKFLOW_DECIDE_PROMPT_VERSION,
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
    const out = answerSchema.safeParse(raw);
    if (!out.success) throw new Error('The answer was not in the expected shape');
    return out.data;
  };
}

/** The decider for this server, or null without a key (or with WORKFLOW_AI=off) — then every decision is "Not sure". */
export function workflowDeciderFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): WorkflowDecider | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.WORKFLOW_AI?.trim().toLowerCase() === 'off') return null;
  return createWorkflowDecider({ apiKey, db, env });
}

export { WORKFLOW_DECIDE_PROMPT_VERSION };
