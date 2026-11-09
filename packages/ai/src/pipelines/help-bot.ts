import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { HELP_FEATURE, type HelpPageContext, type HelpRequest } from '@repo/core/help';
import { getModel, type TokenUsage } from '../models';
import { HELP_PROMPT_VERSION, helpSystem } from '../prompts/help-v1';
import { trackAiRunQuietly } from '../usage';

/** One help answer (ADR 0088): one request, no tools, metered to `ai_run` (#3). Nothing else is written; the words are not kept. */

export type HelpBotDeps = {
  apiKey: string;
  db: Db;
  /** Test seam: a fake client never reaches the network. */
  client?: Anthropic;
  env?: NodeJS.ProcessEnv;
};

export type HelpAsk = {
  guide: string;
  /** Where the person is, in the guide's own words. Null when it has no such page. */
  page: HelpPageContext | null;
  role: string | null;
  messages: HelpRequest['messages'];
  userId: string;
  agencyId: string;
};

const MAX_TOKENS = 500;

function where(page: HelpPageContext | null): string {
  if (!page) return 'A page not in the guide';
  return `${page.name}${page.tab ? `, on its ${page.tab} tab` : ''}. ${page.what}`.trim();
}

export async function answerHelp(deps: HelpBotDeps, ask: HelpAsk): Promise<string | null> {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  const model = getModel('skill-summary', deps.env);
  const startedAt = Date.now();
  const last = ask.messages.length - 1;
  const response = await client.messages.create({
    model: model.id,
    max_tokens: Math.min(model.maxTokens, MAX_TOKENS),
    system: [{ type: 'text', text: helpSystem(ask.guide), cache_control: { type: 'ephemeral' } }],
    messages: ask.messages.map((m, i) => ({
      role: m.role,
      content: i === last ? `<current_page>${where(ask.page)}</current_page>\n<person_role>${ask.role ?? 'unknown'}</person_role>\n${m.text}` : m.text,
    })),
  });
  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
    ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
  };
  await trackAiRunQuietly(deps.db, { feature: HELP_FEATURE, model: model.id, usage, latencyMs: Date.now() - startedAt, userId: ask.userId, agencyId: ask.agencyId, promptVersion: HELP_PROMPT_VERSION });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text || null;
}
