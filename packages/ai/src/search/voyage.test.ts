import { describe, expect, it } from 'vitest';
import { embedderFromEnv, VOYAGE_EMBEDDINGS_URL } from './voyage';

/** ADR 0031: off unless configured; every call metered; the key only in a header. Never the network here. */

const vec = (n: number) => Array.from({ length: 1024 }, (_, i) => (i === n ? 1 : 0));
function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  return { rows, db: { insert: () => ({ values: async (v: Record<string, unknown>) => void rows.push(v) }) } as never };
}

describe('the Voyage embedder', () => {
  it('is off without EMBEDDINGS_PROVIDER=voyage and a key — search falls back to full-text', () => {
    const { db } = fakeDb();
    expect(embedderFromEnv(db, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(embedderFromEnv(db, { EMBEDDINGS_PROVIDER: 'voyage' } as NodeJS.ProcessEnv)).toBeNull();
    expect(embedderFromEnv(db, { VOYAGE_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('sends the texts with the input type, the key as a bearer header, and writes ai_run with Voyage’s token count', async () => {
    const { db, rows } = fakeDb();
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ data: [{ embedding: vec(1), index: 1 }, { embedding: vec(0), index: 0 }], usage: { total_tokens: 1000 } }), { status: 200 });
    }) as never;
    const e = embedderFromEnv(db, { EMBEDDINGS_PROVIDER: 'voyage', VOYAGE_API_KEY: 'secret-key' } as NodeJS.ProcessEnv, fetchImpl)!;
    const out = await e.embed(['a pool', 'a garden'], 'document', { feature: 'search_embedding', agencyId: 'ag-1' });
    expect(out[0]![0]).toBe(1); // re-ordered by index
    expect(seen[0]!.url).toBe(VOYAGE_EMBEDDINGS_URL);
    expect(seen[0]!.url).not.toContain('secret-key');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ input: ['a pool', 'a garden'], model: 'voyage-4', input_type: 'document' });
    expect(rows[0]).toMatchObject({ feature: 'search_embedding', model: 'voyage-4', inputTokens: 1000, agencyId: 'ag-1', costUsd: '0.00006' });
  });

  it('refuses a malformed answer or an error status rather than storing a wrong vector', async () => {
    const { db } = fakeDb();
    const bad = (async () => new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3], index: 0 }] }), { status: 200 })) as never;
    const e = embedderFromEnv(db, { EMBEDDINGS_PROVIDER: 'voyage', VOYAGE_API_KEY: 'k' } as NodeJS.ProcessEnv, bad)!;
    await expect(e.embed(['x'], 'query', { feature: 'assistant', agencyId: 'a', userId: 'u' })).rejects.toThrow(/wrong number or size/);
    const down = (async () => new Response('{}', { status: 429 })) as never;
    await expect(embedderFromEnv(db, { EMBEDDINGS_PROVIDER: 'voyage', VOYAGE_API_KEY: 'k' } as NodeJS.ProcessEnv, down)!.embed(['x'], 'query', { feature: 'assistant', agencyId: 'a' })).rejects.toThrow(/429/);
  });
});
