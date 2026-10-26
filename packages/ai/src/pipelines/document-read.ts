import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { DOCUMENT_READ_FEATURE, type DocumentReader } from '@repo/core/documents';
import { getModel, SERVER_FALLBACK_MODELS, type TokenUsage } from '../models';
import { trackAiRunQuietly } from '../usage';
import { DOCUMENT_READ_INSTRUCTION, DOCUMENT_READ_PROMPT_VERSION, DOCUMENT_READ_SYSTEM } from '../prompts/document-read-v1';

/**
 * The vision reader behind the document tick (ADR 0053 §4): one streamed request per scanned
 * PDF or photo, the file as a base64 `document` / `image` block, metered to `ai_run` (#3) under
 * the document's agency. It returns the words, page by page — never a summary, never a figure
 * the model worked out (#4): what is on the page is what is stored.
 */

const BETAS_FALLBACK = 'server-side-fallback-2026-07-01';
const PAGE_MARK = /^=== Page (\d+) ===\s*$/m;

type ImageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export type DocumentReaderDeps = {
  apiKey: string;
  db: Db;
  /** Test seam: a fake client never reaches the network. */
  client?: Anthropic;
  env?: NodeJS.ProcessEnv;
};

/** "=== Page N ===" sections → one string per page, in order; text before the first mark is page 1. */
export function splitTranscript(text: string): string[] {
  const parts = text.split(/^=== Page \d+ ===\s*$/m);
  if (!PAGE_MARK.test(text)) return [text.trim()];
  const pages = parts.slice(1).map((p) => p.trim());
  const lead = parts[0]?.trim();
  if (lead) pages[0] = pages[0] ? `${lead}\n${pages[0]}` : lead;
  return pages.map((p) => (p === '[no text]' ? '' : p));
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function createDocumentReader(deps: DocumentReaderDeps): DocumentReader {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  const model = getModel('document-read', deps.env);
  return {
    model: model.id,
    async read(input) {
      const data = toBase64(input.bytes);
      const file: Anthropic.Beta.BetaContentBlockParam =
        input.mimeType === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
          : { type: 'image', source: { type: 'base64', media_type: input.mimeType as ImageType, data } };
      const fallback = SERVER_FALLBACK_MODELS.has(model.id);
      const startedAt = Date.now();
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      try {
        const message = await client.beta.messages
          .stream({
            model: model.id,
            max_tokens: model.maxTokens,
            ...(fallback ? { betas: [BETAS_FALLBACK], fallbacks: 'default' as const } : {}),
            ...(model.adaptiveThinking ? { thinking: { type: 'adaptive' as const } } : {}),
            ...(model.effort ? { output_config: { effort: model.effort } } : {}),
            system: [{ type: 'text', text: DOCUMENT_READ_SYSTEM, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: [file, { type: 'text', text: DOCUMENT_READ_INSTRUCTION }] }],
          })
          .finalMessage();
        usage = {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          ...(message.usage.cache_creation_input_tokens != null ? { cacheCreationInputTokens: message.usage.cache_creation_input_tokens } : {}),
          ...(message.usage.cache_read_input_tokens != null ? { cacheReadInputTokens: message.usage.cache_read_input_tokens } : {}),
        };
        if (message.stop_reason === 'refusal') throw new Error('The model declined to read this file');
        // A transcript cut off mid-page would be stored as if it were the whole document.
        if (message.stop_reason === 'max_tokens') throw new Error('The file was too long to read in one pass');
        const text = message.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        if (!text) throw new Error('The model returned no text');
        return { pages: splitTranscript(text) };
      } finally {
        // Metered whatever happened: a failed read still cost what it cost.
        await trackAiRunQuietly(deps.db, {
          feature: DOCUMENT_READ_FEATURE,
          model: model.id,
          usage,
          latencyMs: Date.now() - startedAt,
          entityId: input.documentId,
          agencyId: input.agencyId,
          ...(input.userId ? { userId: input.userId } : {}),
          promptVersion: DOCUMENT_READ_PROMPT_VERSION,
        });
      }
    },
  };
}

/** The reader for this server, or null without a key — then scans are marked "reading is not switched on". */
export function documentReaderFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env): DocumentReader | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || env.DOCUMENTS_VISION === 'off') return null;
  return createDocumentReader({ apiKey, db, env });
}

export { DOCUMENT_READ_PROMPT_VERSION };
