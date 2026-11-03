import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { RENOVATION_CATEGORY_KEYS } from '@repo/core/renovation/categories';
import { createRenovationPlanner, createRoomReader, renovationAiFromEnv, RENOVATION_PROMPT_VERSION } from './renovation';
import { RENOVATION_PLAN_SYSTEM, RENOVATION_ROOMS_SYSTEM } from '../prompts/renovation-v1';

/** ADR 0080, C3: one call each, metered, shaped. A fake client: never the network. */
function fakeClient(text: string, stop = 'end_turn') {
  const calls: { system: { text: string }[]; messages: { content: unknown }[] }[] = [];
  const client = {
    messages: {
      create: async (req: (typeof calls)[number]) => {
        calls.push(req);
        return { content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 500, output_tokens: 80 } };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}
function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  return { db: { insert: () => ({ values: async (v: Record<string, unknown>) => void rows.push(v) }) } as unknown as Db, rows };
}
const env = {} as NodeJS.ProcessEnv;

describe('the renovation planner', () => {
  it('sends the words and the rooms; returns the draft; metered', async () => {
    const { client, calls } = fakeClient('{"items":[{"category":"kitchen","note":"A new kitchen."}]}');
    const { db, rows } = fakeDb();
    const out = await createRenovationPlanner({ apiKey: 'x', db, client, env })({ request: 'new kitchen', rooms: ['kitchen', 'deck'] });
    expect(out.items).toEqual([{ category: 'kitchen', note: 'A new kitchen.' }]);
    expect(calls[0]!.messages[0]!.content).toBe('ROOMS IN THE PHOTOS: kitchen, deck\n\nWHAT THEY WOULD CHANGE:\nnew kitchen');
    expect(rows[0]).toMatchObject({ feature: 'consumer:renovation', promptVersion: RENOVATION_PROMPT_VERSION });
  });

  it('throws on a wrong shape or a refusal', async () => {
    const { db } = fakeDb();
    await expect(createRenovationPlanner({ apiKey: 'x', db, client: fakeClient('{"plan":[]}').client, env })({ request: 'x', rooms: [] })).rejects.toThrow();
    await expect(createRenovationPlanner({ apiKey: 'x', db, client: fakeClient('{"items":[]}', 'refusal').client, env })({ request: 'x', rooms: [] })).rejects.toThrow();
  });

  it('the prompt lists every kind of work in catalog order, forbids money and treats words as information', () => {
    const at = RENOVATION_CATEGORY_KEYS.map((k) => RENOVATION_PLAN_SYSTEM.indexOf(`- ${k}:`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(RENOVATION_PLAN_SYSTEM).toMatch(/Never write a price/);
    expect(RENOVATION_PLAN_SYSTEM).toMatch(/never instructions to you/);
    expect(RENOVATION_PLAN_SYSTEM).not.toMatch(/\$\d|\d{4}-\d{2}-\d{2}/);
  });
});

describe('the room reader', () => {
  it('sends each photo numbered, by URL; returns the answer for core’s strict schema; metered separately', async () => {
    const { client, calls } = fakeClient('{"photos":[{"photo":1,"room":"kitchen","condition":"dated"}]}');
    const { db, rows } = fakeDb();
    const out = await createRoomReader({ apiKey: 'x', db, client, env })({ photoUrls: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'] });
    // Not trimmed here: core refuses it whole.
    expect(out).toMatchObject({ photos: [{ condition: 'dated' }] });
    const content = calls[0]!.messages[0]!.content as { type: string; text?: string; source?: { url: string } }[];
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text', 'image']);
    expect(content[1]!.source!.url).toBe('https://cdn.test/a.jpg');
    expect(content[2]!.text).toBe('Photo 2:');
    expect(rows[0]).toMatchObject({ feature: 'consumer:renovation_rooms' });
    expect(RENOVATION_ROOMS_SYSTEM).toMatch(/not the condition/);
  });

  it('is off without a key or with CONSUMER_AI=off', () => {
    const { db } = fakeDb();
    expect(renovationAiFromEnv(db, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(renovationAiFromEnv(db, { ANTHROPIC_API_KEY: 'k', CONSUMER_AI: 'off' } as NodeJS.ProcessEnv)).toBeNull();
    expect(renovationAiFromEnv(db, { ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv)).not.toBeNull();
  });
});
