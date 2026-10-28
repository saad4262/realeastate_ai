import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Db } from '@repo/db';
import { INBOX_DRAFT_FEATURE, INBOX_SUMMARY_FEATURE, type AssistMessage, type ReplyDrafter, type ThreadSummarizer } from '@repo/core/mail/reply-assist';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { REPLY_ASSIST_PROMPT_VERSION, REPLY_DRAFT_SYSTEM, THREAD_SUMMARY_SYSTEM } from '../prompts/reply-assist-v1';

/**
 * The model calls behind the inbox assistant (ADR 0062): one request each, no tools, metered to `ai_run`
 * (#3), the answer checked by zod here and by core after (citations, figures). Nothing here sends.
 */

const summarySchema = z
  .object({ points: z.array(z.object({ text: z.string().trim().min(1).max(400), messages: z.array(z.number().int().min(1)).min(1).max(12) }).strict()).min(1).max(8) })
  .strict();
const draftSchema = z.object({ body: z.string().trim().min(1).max(6000) }).strict();

export type ReplyAssistDeps = {
  apiKey: string;
  db: Db;
  /** Test seam: a fake client never reaches the network. */
  client?: Anthropic;
  env?: NodeJS.ProcessEnv;
};

function messagesBlock(messages: AssistMessage[]): string {
  return messages.map((m) => `[${m.n}] ${m.from === 'contact' ? 'CONTACT' : 'AGENT'} (${m.name}, ${m.at}):\n${m.text}`).join('\n\n');
}

async function ask(
  deps: ReplyAssistDeps,
  client: Anthropic,
  input: { system: string; user: string; feature: string; agencyId: string; userId: string; maxTokens: number },
): Promise<unknown> {
  const model = getModel('skill-agent', deps.env);
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
  await trackAiRunQuietly(deps.db, {
    feature: input.feature,
    model: model.id,
    usage,
    latencyMs: Date.now() - startedAt,
    userId: input.userId,
    agencyId: input.agencyId,
    promptVersion: REPLY_ASSIST_PROMPT_VERSION,
  });
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

export function createReplyAssist(deps: ReplyAssistDeps): { summarizer: ThreadSummarizer; drafter: ReplyDrafter } {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return {
    summarizer: async (input) => {
      const raw = await ask(deps, client, {
        system: THREAD_SUMMARY_SYSTEM,
        user: `MESSAGES:\n${messagesBlock(input.messages)}`,
        feature: INBOX_SUMMARY_FEATURE,
        agencyId: input.agencyId,
        userId: input.userId,
        maxTokens: 1200,
      });
      const out = summarySchema.safeParse(raw);
      if (!out.success) throw new Error('The summary was not in the expected shape');
      return out.data;
    },
    drafter: async (input) => {
      const user = [
        `MESSAGES:\n${messagesBlock(input.messages)}`,
        `TONE: ${input.tone}`,
        `AGENT_SAYS: ${input.instruction ?? '(nothing given)'}`,
        `NAMES: ${JSON.stringify({ client_first_name: input.contactFirstName || null, agent_name: input.agentName || null })}`,
      ].join('\n\n');
      const raw = await ask(deps, client, { system: REPLY_DRAFT_SYSTEM, user, feature: INBOX_DRAFT_FEATURE, agencyId: input.agencyId, userId: input.userId, maxTokens: 1500 });
      const out = draftSchema.safeParse(raw);
      if (!out.success) throw new Error('The draft was not in the expected shape');
      return out.data;
    },
  };
}

/** The assistant for this server, or null without a key (or with INBOX_AI=off) — then the panel says so. */
export function replyAssistFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): ReturnType<typeof createReplyAssist> | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.INBOX_AI?.trim().toLowerCase() === 'off') return null;
  return createReplyAssist({ apiKey, db, env });
}

export { REPLY_ASSIST_PROMPT_VERSION };
