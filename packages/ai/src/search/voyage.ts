import type { DbOrTx } from '@repo/db';
import { EMBEDDING_DIMENSIONS, type Embedder } from '@repo/core/assistant-search';
import { trackAiRunQuietly } from '../usage';

/**
 * Voyage AI embeddings for the assistant's search (ADR 0031), checked against
 * docs.voyageai.com on 2026-10-07: POST /v1/embeddings, Bearer key, `input`
 * up to 1,000 texts, `input_type` document|query, `voyage-4` = 1024 floats.
 * Every call writes ai_run (non-negotiable #3) with the tokens Voyage counted.
 */

export const VOYAGE_EMBEDDINGS_URL = 'https://api.voyageai.com/v1/embeddings';
export const VOYAGE_MODEL = 'voyage-4';
const BATCH = 128;
const TIMEOUT_MS = 20_000;

type VoyageResponse = { data?: { embedding?: number[]; index?: number }[]; usage?: { total_tokens?: number } };

/**
 * The embedder, when EMBEDDINGS_PROVIDER=voyage and VOYAGE_API_KEY is set;
 * otherwise null — and search is full-text only, never an error.
 */
export function embedderFromEnv(db: DbOrTx, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Embedder | null {
  const provider = env.EMBEDDINGS_PROVIDER?.trim().toLowerCase();
  const key = env.VOYAGE_API_KEY?.trim();
  if (provider !== 'voyage' || !key) return null;
  return {
    model: VOYAGE_MODEL,
    async embed(texts, inputType, meter) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const started = Date.now();
        let res: Response;
        try {
          res = await fetchImpl(VOYAGE_EMBEDDINGS_URL, {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({ input: batch, model: VOYAGE_MODEL, input_type: inputType }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch {
          throw new Error('Voyage could not be reached');
        }
        if (!res.ok) throw new Error(`Voyage answered ${res.status}`);
        const body = (await res.json().catch(() => null)) as VoyageResponse | null;
        const data = [...(body?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (data.length !== batch.length || data.some((d) => !Array.isArray(d.embedding) || d.embedding.length !== EMBEDDING_DIMENSIONS)) {
          throw new Error('Voyage returned the wrong number or size of vectors');
        }
        await trackAiRunQuietly(db, {
          feature: meter.feature,
          model: VOYAGE_MODEL,
          usage: { inputTokens: body?.usage?.total_tokens ?? 0, outputTokens: 0 },
          latencyMs: Date.now() - started,
          agencyId: meter.agencyId,
          ...(meter.userId ? { userId: meter.userId } : {}),
          promptVersion: `embed-${inputType}@v1`,
        });
        out.push(...data.map((d) => d.embedding!));
      }
      return out;
    },
  };
}
