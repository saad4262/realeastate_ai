import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import type { SkillWriter } from '@repo/core/skills';
import { getModel, type AiFeature, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { IMPORTANT_EMAILS_SYSTEM, MORNING_BRIEF_SYSTEM, SKILL_PROMPT_VERSION } from '../prompts/skills-v1';

/**
 * The model call behind a skill (docs/adr/0021) — one request, no tools,
 * metered to `ai_run` with the run's id as entity_id (#3). It returns text;
 * whether that text may be shown is decided in packages/core by the citation
 * checker, never here.
 */

const TIER_FEATURE: Record<'summary' | 'agent' | 'hard', AiFeature> = {
  summary: 'skill-summary',
  agent: 'skill-agent',
  hard: 'skill-hard',
};

export type SkillWriterDeps = {
  apiKey: string;
  db: Db;
  /** Test seam: a fake client never reaches the network. */
  client?: Anthropic;
  env?: NodeJS.ProcessEnv;
};

export function createSkillWriter(deps: SkillWriterDeps): SkillWriter {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async (input) => {
    const model = getModel(TIER_FEATURE[input.tier], deps.env);
    const system = input.handler === 'morning_brief' ? MORNING_BRIEF_SYSTEM : IMPORTANT_EMAILS_SYSTEM;
    const user = [
      `Today is ${input.today}.`,
      '',
      "The agent's own instructions for this skill:",
      input.instructions.slice(0, 4000) || '(none)',
      '',
      'RECORDS:',
      ...input.records.map((r) => `[${r.ref}] ${r.text}`),
    ].join('\n');

    const startedAt = Date.now();
    const response = await client.messages.create({
      model: model.id,
      max_tokens: model.maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      ...(model.effort ? { output_config: { effort: model.effort } } : {}),
      messages: [{ role: 'user', content: user }],
    });

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
      ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
    };
    // Metered whatever happens to the text (#3).
    await trackAiRunQuietly(deps.db, {
      feature: `skill:${input.handler}`,
      model: model.id,
      usage,
      latencyMs: Date.now() - startedAt,
      entityId: input.runId,
      userId: input.userId,
      promptVersion: SKILL_PROMPT_VERSION,
    });

    // A refusal or a cut-off answer is no answer: the template stands.
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      return { text: null, model: model.id };
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return { text: text || null, model: model.id };
  };
}

/** The writer for this server, or undefined without a key — then skills use templates only. */
export function skillWriterFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): SkillWriter | undefined {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  return apiKey ? createSkillWriter({ apiKey, db, env }) : undefined;
}

export { SKILL_PROMPT_VERSION };
