import type { DbOrTx } from '@repo/db';
import { VISUAL_DIMENSIONS, VISUAL_EMBED_FEATURE, VISUAL_MODEL, VISUAL_SEARCH_FEATURE, type ImageEmbedder } from '@repo/core/visual-search';
import { trackAiRunQuietly } from '../usage';

/**
 * Voyage multimodal embeddings for Visual Search (ADR 0080, C9 decision 8), checked against docs.voyageai.com on
 * 2026-11-04: POST /v1/multimodalembeddings, Bearer key, `inputs[].content[]` of `{type:'image_url', image_url}` or
 * `{type:'text', text}`, `input_type` document|query, `voyage-multimodal-3.5` = 1024 floats by default, up to 1,000
 * inputs a request; usage reports text_tokens, image_pixels and total_tokens (560 pixels a token). Photos are public
 * ad photos, sent by URL; a buyer's own image is never sent (decision 9). Every call writes ai_run (#3).
 */

export const VOYAGE_MULTIMODAL_URL = 'https://api.voyageai.com/v1/multimodalembeddings';
const TIMEOUT_MS = 30_000;

type Body = { data?: { embedding?: unknown; index?: number }[]; usage?: { total_tokens?: number } };

export type VisualEmbedDeps = { apiKey: string; db: DbOrTx; fetch?: typeof fetch };

export function createImageEmbedder(deps: VisualEmbedDeps): ImageEmbedder {
  const fetchImpl = deps.fetch ?? fetch;
  const call = async (inputs: { content: ({ type: 'image_url'; image_url: string } | { type: 'text'; text: string })[] }[], inputType: 'document' | 'query', feature: string): Promise<number[][]> => {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(VOYAGE_MULTIMODAL_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ inputs, model: VISUAL_MODEL, input_type: inputType }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error('Voyage could not be reached');
    }
    if (!res.ok) throw new Error(`Voyage answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as Body | null;
    const data = [...(body?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    await trackAiRunQuietly(deps.db, {
      feature,
      model: VISUAL_MODEL,
      usage: { inputTokens: body?.usage?.total_tokens ?? 0, outputTokens: 0 },
      latencyMs: Date.now() - started,
      promptVersion: `visual-embed-${inputType}@v1`,
    });
    const ok = data.length === inputs.length && data.every((d) => Array.isArray(d.embedding) && d.embedding.length === VISUAL_DIMENSIONS && d.embedding.every((x) => typeof x === 'number' && Number.isFinite(x)));
    if (!ok) throw new Error('Voyage returned the wrong number or size of vectors');
    return data.map((d) => d.embedding as number[]);
  };
  return {
    model: VISUAL_MODEL,
    embedImages: (urls) => (urls.length ? call(urls.map((u) => ({ content: [{ type: 'image_url', image_url: u }] })), 'document', VISUAL_EMBED_FEATURE) : Promise.resolve([])),
    embedQuery: async (text) => (await call([{ content: [{ type: 'text', text }] }], 'query', VISUAL_SEARCH_FEATURE))[0]!,
  };
}

/** The embedder when VOYAGE_API_KEY is set; otherwise null — Visual Search then says it cannot run, never an error. */
export function imageEmbedderFromEnv(db: DbOrTx, env: NodeJS.ProcessEnv = process.env): ImageEmbedder | null {
  const key = env.VOYAGE_API_KEY?.trim();
  return key ? createImageEmbedder({ apiKey: key, db }) : null;
}
