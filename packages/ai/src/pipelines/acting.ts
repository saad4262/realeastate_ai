import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { AGENT_MESSAGE_FEATURE, type AgentDraftWriter } from '@repo/core/agent-messages';
import type { TaskDeps, TaskSummaryFacts } from '@repo/core/tasks';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { AGENT_MESSAGE_PROMPT_VERSION, AGENT_MESSAGE_SYSTEM } from '../prompts/agent-message-v1';
import { TASK_SUMMARY_PROMPT_VERSION, TASK_SUMMARY_SYSTEM } from '../prompts/task-summary-v1';

/**
 * The two model calls behind C8 (ADR 0080): Agent AI's draft and a task report's opening sentence. One request each,
 * no tools, the summary tier, metered to `ai_run` (#3). Core checks both after (#4, #7): the draft against the buyer's
 * words and the listing's facts, the sentence for figures, counting words and verdicts.
 */

export const TASK_SUMMARY_FEATURE = 'consumer:task_summary';
export type ActingDeps = { apiKey: string; db: Db; client?: Anthropic; env?: NodeJS.ProcessEnv };

async function ask(deps: ActingDeps, input: { system: string; user: string; maxTokens: number; feature: string; promptVersion: string; userId?: string }): Promise<string> {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  const model = getModel('skill-summary', deps.env);
  const startedAt = Date.now();
  const response = await client.messages.create({
    model: model.id,
    max_tokens: Math.min(model.maxTokens, input.maxTokens),
    system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: input.user }],
  });
  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
    ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
  };
  await trackAiRunQuietly(deps.db, { feature: input.feature, model: model.id, usage, latencyMs: Date.now() - startedAt, promptVersion: input.promptVersion, ...(input.userId ? { userId: input.userId } : {}) });
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') throw new Error('The model did not answer');
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/^["“]|["”]$/g, '');
}

export function createAgentMessageWriter(deps: ActingDeps): AgentDraftWriter {
  return async (input, ctx) =>
    ask(deps, {
      system: AGENT_MESSAGE_SYSTEM,
      user: `LISTING (${input.agencyName}):\n${input.listingFacts.join('\n')}\n\nBUYER SAID:\n${input.buyerWords}\n\nLATEST:\n${input.latest}`,
      maxTokens: 600,
      feature: AGENT_MESSAGE_FEATURE,
      promptVersion: AGENT_MESSAGE_PROMPT_VERSION,
      userId: ctx.userId,
    });
}

export function createTaskSummaryWriter(deps: ActingDeps): NonNullable<TaskDeps['summariseTask']> {
  return async (facts: TaskSummaryFacts, ctx) => {
    const text = await ask(deps, {
      system: TASK_SUMMARY_SYSTEM,
      user: JSON.stringify({ report: facts.taskName, suburb: facts.suburb, sections: facts.sections.map((s) => ({ section: s.title, hasSomething: s.hasSomething })) }),
      maxTokens: 200,
      feature: TASK_SUMMARY_FEATURE,
      promptVersion: TASK_SUMMARY_PROMPT_VERSION,
      userId: ctx.userId,
    });
    return text ? { source: 'model', text } : { source: 'template', text: null };
  };
}

const keyFrom = (env: NodeJS.ProcessEnv) => (env.CONSUMER_AI?.trim().toLowerCase() === 'off' ? null : env.ANTHROPIC_API_KEY?.trim() || null);

/** The writers for this server, or null without a key (or with CONSUMER_AI=off): the template is used instead. */
export function agentMessageWriterFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): AgentDraftWriter | null {
  const apiKey = keyFrom(env);
  return apiKey ? createAgentMessageWriter({ apiKey, db, env }) : null;
}
export function taskSummaryWriterFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): TaskDeps['summariseTask'] | null {
  const apiKey = keyFrom(env);
  return apiKey ? createTaskSummaryWriter({ apiKey, db, env }) : null;
}

export { AGENT_MESSAGE_PROMPT_VERSION, TASK_SUMMARY_PROMPT_VERSION };
