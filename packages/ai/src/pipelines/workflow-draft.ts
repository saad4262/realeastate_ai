import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Db } from '@repo/db';
import type { DraftWriter } from '@repo/core/workflows';
import { getModel, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { WORKFLOW_DRAFT_PROMPT_VERSION, WORKFLOW_DRAFT_SYSTEM } from '../prompts/workflow-draft-v1';

/**
 * The model call behind a workflow's `draft_email` step (ADR 0041 D1): one request, no tools, metered
 * to `ai_run` (#3). It returns a subject and a body, checked by zod; core makes them a DRAFT card the
 * agent approves word for word, with every figure listed. Nothing here sends.
 */

const draftSchema = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000) }).strict();

export type WorkflowDraftDeps = {
  apiKey: string;
  db: Db;
  /** Test seam: a fake client never reaches the network. */
  client?: Anthropic;
  env?: NodeJS.ProcessEnv;
};

export function createWorkflowDraftWriter(deps: WorkflowDraftDeps): DraftWriter {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  return async (input) => {
    // The skills' agent tier: a short piece of writing for a person to check.
    const model = getModel('skill-agent', deps.env);
    const user = [
      'INSTRUCTIONS:',
      input.instructions.slice(0, 1000),
      '',
      'FACTS:',
      JSON.stringify({
        contact_name: input.facts.contactName,
        contact_first_name: input.facts.contactFirstName,
        agent_name: input.facts.agentName,
        agency_name: input.facts.agencyName,
        ...(input.facts.listingAddress ? { listing_address: input.facts.listingAddress } : {}),
      }),
    ].join('\n');
    const startedAt = Date.now();
    const response = await client.messages.create({
      model: model.id,
      max_tokens: Math.min(model.maxTokens, 1500),
      system: [{ type: 'text', text: WORKFLOW_DRAFT_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    });
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: response.usage.cache_creation_input_tokens } : {}),
      ...(response.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
    };
    await trackAiRunQuietly(deps.db, {
      feature: 'workflow:draft_email',
      model: model.id,
      usage,
      latencyMs: Date.now() - startedAt,
      userId: input.userId,
      agencyId: input.agencyId,
      promptVersion: WORKFLOW_DRAFT_PROMPT_VERSION,
    });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') throw new Error('The model did not write a draft');
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .replace(/^```(?:json)?\s*|\s*```$/g, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('The draft was not in the expected shape');
    }
    const out = draftSchema.safeParse(parsed);
    if (!out.success) throw new Error('The draft was not in the expected shape');
    return out.data;
  };
}

/** The writer for this server, or null without a key — then a draft step says no draft was written. */
export function workflowDraftWriterFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): DraftWriter | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  return apiKey ? createWorkflowDraftWriter({ apiKey, db, env }) : null;
}

export { WORKFLOW_DRAFT_PROMPT_VERSION };
