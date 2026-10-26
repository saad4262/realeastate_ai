import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import type { Db } from '@repo/db';
import {
  CLEANABLE_FIELDS,
  CONTACT_FIELD_LABELS,
  CONTACT_IMPORT_FIELDS,
  IMPORT_CLEAN_FEATURE,
  IMPORT_MAP_FEATURE,
  type CleanableField,
  type ColumnMapper,
  type ContactImportField,
  type RowCleaner,
  type RowFix,
} from '@repo/core/imports';
import { getModel, SERVER_FALLBACK_MODELS, type ModelChoice, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { IMPORT_ASSIST_PROMPT_VERSION, IMPORT_CLEAN_SYSTEM, IMPORT_MAP_SYSTEM } from '../prompts/import-assist-v1';

/**
 * The contacts import's AI help (ADR 0056), behind core's ColumnMapper and RowCleaner. One
 * structured-output request each — the answer is parsed against a schema, then core checks every
 * value again (range, repeats, and for fixes the guards that prove a value came from the row).
 * Metered to `ai_run` (#3) under the import's agency, whatever happens.
 */

const BETAS_FALLBACK = 'server-side-fallback-2026-07-01';
/** An upload waits on the mapping; a slow model must not hold it. Core falls back to the synonyms. */
const REQUEST = { timeout: 30_000, maxRetries: 1 };

const MapOutput = z.object({
  // Field names as plain strings, filtered in code: the API takes an enum only as a hint (the SDK moves it
  // into the description), and one unknown name must cost that entry, not the whole answer.
  columns: z.array(z.object({ field: z.string().describe(`One of: ${CONTACT_IMPORT_FIELDS.join(', ')}`), column: z.number().int() })),
});

const CleanOutput = z.object({
  rows: z.array(
    z.object({
      rowNumber: z.number().int(),
      fixes: z.array(z.object({ field: z.string().describe(`One of: ${CLEANABLE_FIELDS.join(', ')}`), value: z.string() })),
    }),
  ),
});

/** What each field holds, for the mapping prompt. */
const FIELD_HINTS: Record<ContactImportField, string> = {
  ...CONTACT_FIELD_LABELS,
  roles: 'The kind of client: buyer, seller, landlord, tenant or investor',
  assigned_email: 'The email of the agency’s agent responsible for this person',
  next_action_date: 'When to follow up (a date)',
};

export type ImportAssistDeps = {
  apiKey: string;
  db: Db;
  /** Test seam: a fake client never reaches the network. */
  client?: Anthropic;
  env?: NodeJS.ProcessEnv;
};

type Call = { feature: string; system: string; payload: unknown; entityId: string; agencyId: string; userId: string | null };

function usageOf(u: Anthropic.Beta.BetaUsage): TokenUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    ...(u.cache_creation_input_tokens != null ? { cacheCreationInputTokens: u.cache_creation_input_tokens } : {}),
    ...(u.cache_read_input_tokens != null ? { cacheReadInputTokens: u.cache_read_input_tokens } : {}),
  };
}

/** One parsed request: refusal, a cut-off answer or an unparseable one all throw — and are metered. */
async function ask<T>(deps: ImportAssistDeps, client: Anthropic, model: ModelChoice, call: Call, schema: z.ZodType<T>): Promise<T> {
  const fallback = SERVER_FALLBACK_MODELS.has(model.id);
  const startedAt = Date.now();
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  try {
    const message = await client.beta.messages.parse(
      {
        model: model.id,
        max_tokens: model.maxTokens,
        ...(fallback ? { betas: [BETAS_FALLBACK], fallbacks: 'default' as const } : {}),
        ...(model.adaptiveThinking ? { thinking: { type: 'adaptive' as const } } : {}),
        output_config: { ...(model.effort ? { effort: model.effort } : {}), format: betaZodOutputFormat(schema) },
        system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: JSON.stringify(call.payload) }],
      },
      REQUEST,
    );
    usage = usageOf(message.usage);
    if (message.stop_reason === 'refusal') throw new Error('The model declined');
    if (message.stop_reason === 'max_tokens') throw new Error('The answer was cut off');
    if (!message.parsed_output) throw new Error('The answer did not match the schema');
    return message.parsed_output;
  } finally {
    await trackAiRunQuietly(deps.db, {
      feature: call.feature,
      model: model.id,
      usage,
      latencyMs: Date.now() - startedAt,
      entityId: call.entityId,
      agencyId: call.agencyId,
      ...(call.userId ? { userId: call.userId } : {}),
      promptVersion: IMPORT_ASSIST_PROMPT_VERSION,
    });
  }
}

export function createColumnMapper(deps: ImportAssistDeps): ColumnMapper {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  const model = getModel('import-map', deps.env);
  return {
    model: model.id,
    async suggest(input) {
      const out = await ask(
        deps,
        client,
        model,
        {
          feature: IMPORT_MAP_FEATURE,
          system: IMPORT_MAP_SYSTEM,
          payload: { headers: input.headers, samples: input.samples, fields: FIELD_HINTS },
          entityId: input.importId,
          agencyId: input.agencyId,
          userId: input.userId,
        },
        MapOutput,
      );
      // First claim per field wins; core drops anything out of range or repeated.
      const mapping: Partial<Record<ContactImportField, number>> = {};
      for (const c of out.columns) {
        if (!(CONTACT_IMPORT_FIELDS as readonly string[]).includes(c.field)) continue;
        const field = c.field as ContactImportField;
        if (mapping[field] === undefined) mapping[field] = c.column;
      }
      return mapping;
    },
  };
}

export function createRowCleaner(deps: ImportAssistDeps): RowCleaner {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  const model = getModel('import-clean', deps.env);
  return {
    model: model.id,
    async clean(input) {
      const out = await ask(
        deps,
        client,
        model,
        {
          feature: IMPORT_CLEAN_FEATURE,
          system: IMPORT_CLEAN_SYSTEM,
          payload: { rows: input.rows },
          entityId: input.importId,
          agencyId: input.agencyId,
          userId: input.userId,
        },
        CleanOutput,
      );
      return out.rows.map((r): RowFix => {
        const values: Partial<Record<CleanableField, string>> = {};
        for (const f of r.fixes) {
          if (!(CLEANABLE_FIELDS as readonly string[]).includes(f.field)) continue;
          const field = f.field as CleanableField;
          if (values[field] === undefined) values[field] = f.value;
        }
        return { rowNumber: r.rowNumber, values };
      });
    },
  };
}

/** Both, for this server — or null without a key, or with IMPORT_AI=off; then imports work as before. */
export function importAssistFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): { mapper: ColumnMapper; cleaner: RowCleaner } | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.IMPORT_AI === 'off') return null;
  const deps = { apiKey, db, env };
  return { mapper: createColumnMapper(deps), cleaner: createRowCleaner(deps) };
}

export { IMPORT_ASSIST_PROMPT_VERSION };
