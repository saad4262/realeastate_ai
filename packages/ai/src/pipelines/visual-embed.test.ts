import { describe, expect, it, vi } from 'vitest';
import type { DbOrTx } from '@repo/db';
import { createImageEmbedder, imageEmbedderFromEnv, VOYAGE_MULTIMODAL_URL } from './visual-embed';

vi.mock('../usage', () => ({ trackAiRunQuietly: vi.fn(async () => {}) }));
import { trackAiRunQuietly } from '../usage';

const VEC = Array.from({ length: 1024 }, () => 0.01);
const answer = (n: number, over: object = {}) => new Response(JSON.stringify({ object: 'list', data: Array.from({ length: n }, (_, i) => ({ object: 'embedding', embedding: VEC, index: n - 1 - i })).reverse(), model: 'voyage-multimodal-3.5', usage: { text_tokens: 0, image_pixels: 2000000, total_tokens: 3572 }, ...over }), { status: 200 });
const db = {} as DbOrTx;

describe('Visual Search embedder (ADR 0080, C9 decision 8) — a fake client only', () => {
  it('photos go as image URLs with input_type document; one call, metered', async () => {
    const f = vi.fn(async () => answer(2));
    const out = await createImageEmbedder({ apiKey: 'k', db, fetch: f as unknown as typeof fetch }).embedImages(['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg']);
    expect(out).toHaveLength(2);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(VOYAGE_MULTIMODAL_URL);
    expect(JSON.parse(String(init.body))).toEqual({ inputs: [{ content: [{ type: 'image_url', image_url: 'https://cdn.test/a.jpg' }] }, { content: [{ type: 'image_url', image_url: 'https://cdn.test/b.jpg' }] }], model: 'voyage-multimodal-3.5', input_type: 'document' });
    expect(trackAiRunQuietly).toHaveBeenCalledWith(db, expect.objectContaining({ feature: 'consumer:visual_embed', model: 'voyage-multimodal-3.5', usage: { inputTokens: 3572, outputTokens: 0 } }));
  });
  it('the buyer’s words go as text with input_type query', async () => {
    const f = vi.fn(async () => answer(1));
    expect(await createImageEmbedder({ apiKey: 'k', db, fetch: f as unknown as typeof fetch }).embedQuery('timber floors')).toHaveLength(1024);
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ inputs: [{ content: [{ type: 'text', text: 'timber floors' }] }], input_type: 'query' });
  });
  it('an error status, a short answer or a wrong-size vector throws — core then writes nothing', async () => {
    const e = (r: Response) => createImageEmbedder({ apiKey: 'k', db, fetch: (async () => r) as unknown as typeof fetch });
    await expect(e(new Response('{}', { status: 429 })).embedImages(['https://cdn.test/a.jpg'])).rejects.toThrow(/429/);
    await expect(e(answer(1)).embedImages(['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'])).rejects.toThrow(/wrong number/);
    await expect(e(answer(1, { data: [{ embedding: [1, 2], index: 0 }] })).embedQuery('x y z')).rejects.toThrow(/wrong number or size/);
  });
  it('no key → no embedder', () => {
    expect(imageEmbedderFromEnv(db, {})).toBeNull();
    expect(imageEmbedderFromEnv(db, { VOYAGE_API_KEY: ' k ' })).not.toBeNull();
  });
});
