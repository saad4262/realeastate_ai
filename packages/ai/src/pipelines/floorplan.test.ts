import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { floorplanRoomsSchema } from '@repo/core/media';
import { createFloorplanReader, floorplanReaderFromEnv, FLOORPLAN_PROMPT_VERSION } from './floorplan';
import { FLOORPLAN_SYSTEM } from '../prompts/floorplan-v1';

/** ADR 0080, C9 decision 3: one image, names only, metered. A fake client: never the network. */
function fakeClient(text: string, stop = 'end_turn') {
  const calls: { system: { text: string }[]; messages: { content: unknown }[] }[] = [];
  const client = { messages: { create: async (req: (typeof calls)[number]) => (calls.push(req), { content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 900, output_tokens: 30 } }) } } as unknown as Anthropic;
  return { client, calls };
}
function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  return { db: { insert: () => ({ values: async (v: Record<string, unknown>) => void rows.push(v) }) } as unknown as Db, rows };
}

describe('the floorplan reader (ADR 0080, C9)', () => {
  it('sends the one image and the names-only prompt, meters the call, and hands back the answer unparsed', async () => {
    const { client, calls } = fakeClient('{"rooms": ["kitchen", "bedroom", "bedroom", "study"]}');
    const { db, rows } = fakeDb();
    const out = await createFloorplanReader({ apiKey: 'k', db, client, env: {} as NodeJS.ProcessEnv })({ imageUrl: 'https://cdn.test/plan.png' });
    expect(floorplanRoomsSchema.safeParse(out).success).toBe(true);
    const content = calls[0]!.messages[0]!.content as { type: string; source?: { url: string } }[];
    expect(content[0]).toMatchObject({ type: 'image', source: { url: 'https://cdn.test/plan.png' } });
    expect(calls[0]!.system[0]!.text).toBe(FLOORPLAN_SYSTEM);
    expect(rows[0]).toMatchObject({ feature: 'consumer:floorplan_rooms', promptVersion: FLOORPLAN_PROMPT_VERSION });
  });
  it('an answer with sizes is returned as it is — and core’s strict schema refuses it', async () => {
    const { client } = fakeClient('{"rooms": ["kitchen"], "sizes": {"kitchen": "4.2 x 3.6"}}');
    const out = await createFloorplanReader({ apiKey: 'k', db: fakeDb().db, client, env: {} as NodeJS.ProcessEnv })({ imageUrl: 'https://cdn.test/plan.png' });
    expect(floorplanRoomsSchema.safeParse(out).success).toBe(false);
  });
  it('prose is not JSON: it comes back unreadable, never thrown', async () => {
    const { client } = fakeClient('The kitchen is about 4 metres wide.');
    expect(await createFloorplanReader({ apiKey: 'k', db: fakeDb().db, client, env: {} as NodeJS.ProcessEnv })({ imageUrl: 'https://cdn.test/p.png' })).toEqual({ unreadable: true });
  });
  it('the prompt forbids sizes; no key or CONSUMER_AI=off → no reader', () => {
    expect(FLOORPLAN_SYSTEM).toMatch(/Never write a dimension, an area, a measurement or a count/);
    expect(floorplanReaderFromEnv({} as Db, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(floorplanReaderFromEnv({} as Db, { ANTHROPIC_API_KEY: 'k', CONSUMER_AI: 'off' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});
