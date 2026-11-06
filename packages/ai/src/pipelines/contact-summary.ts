import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { CONTACT_SUMMARY_FEATURE, type ContactSummarizer } from '@repo/core/contacts';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { CONTACT_SUMMARY_PROMPT_VERSION, CONTACT_SUMMARY_V1 } from '../prompts/contact-summary-v1';
import { findFigures, findOffBrief } from './alert-summary';

/**
 * The model call behind a profile's summary (ADR 0083): one request, no tools, metered to `ai_run` (#3). An answer with a
 * figure, or one that steps out of the brief, is rejected here, not trimmed: core shows nothing and says so (#4).
 */

export type ContactSummaryDeps = {
  apiKey: string;
  db: Db;
  /** Test seam: a fake client never reaches the network. */
  client?: Anthropic;
  env?: NodeJS.ProcessEnv;
};

const MAX_TOKENS = 300;

export function createContactSummarizer(deps: ContactSummaryDeps): ContactSummarizer {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async ({ lines, agencyId, userId }) => {
    const model = getModel('skill-agent', deps.env);
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: model.id,
      max_tokens: Math.min(model.maxTokens, MAX_TOKENS),
      system: [{ type: 'text', text: CONTACT_SUMMARY_V1, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `HISTORY:\n${lines.join('\n')}` }],
    });
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
      ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
    };
    await trackAiRunQuietly(deps.db, {
      feature: CONTACT_SUMMARY_FEATURE,
      model: model.id,
      usage,
      latencyMs: Date.now() - startedAt,
      userId,
      agencyId,
      promptVersion: CONTACT_SUMMARY_PROMPT_VERSION,
    });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return { text: null, rejected: String(response.stop_reason) };
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) return { text: null, rejected: 'empty' };
    const bad = findFigures(text) ?? findOffBrief(text) ?? (text.includes('[figure]') ? 'the mask' : null);
    return bad ? { text: null, rejected: bad } : { text };
  };
}

export function contactSummarizerFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): ContactSummarizer | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.CONTACT_SUMMARY_AI?.trim().toLowerCase() === 'off') return null;
  return createContactSummarizer({ apiKey, db, env });
}

export { CONTACT_SUMMARY_PROMPT_VERSION };
