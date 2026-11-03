import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { createResearchWriter, researchWriterFromEnv, RESEARCH_PROMPT_VERSION } from './research';
import { RESEARCH_SYSTEM } from '../prompts/research-v1';

/** ADR 0080, C5: one call, metered, shaped. A fake client: never the network. */
function fakeClient(text: string, stop = 'end_turn') {
  const calls: { system: { text: string }[]; messages: { content: string }[] }[] = [];
  const client = { messages: { create: async (req: (typeof calls)[number]) => (calls.push(req), { content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 300, output_tokens: 60 } }) } } as unknown as Anthropic;
  return { client, calls };
}
function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  return { db: { insert: () => ({ values: async (v: Record<string, unknown>) => void rows.push(v) }) } as unknown as Db, rows };
}
const env = {} as NodeJS.ProcessEnv;

describe('the research writer', () => {
  it('sends the kind, the subject and the numbered records; returns lines; metered', async () => {
    const { client, calls } = fakeClient('{"lines":[{"text":"42 homes are for sale on this site.","refs":["S1"]}]}');
    const { db, rows } = fakeDb();
    const out = await createResearchWriter({ apiKey: 'x', db, client, env })({ kind: 'suburb', subject: 'Pakenham VIC', records: [{ ref: 'S1', text: 'On this site now: 42 for sale and 3 for rent in Pakenham.' }] });
    expect(out.lines).toHaveLength(1);
    expect(calls[0]!.messages[0]!.content).toBe('KIND: suburb\nABOUT: Pakenham VIC\n\nRECORDS:\n[S1] On this site now: 42 for sale and 3 for rent in Pakenham.');
    expect(calls[0]!.system[0]!.text).toBe(RESEARCH_SYSTEM);
    expect(rows[0]).toMatchObject({ feature: 'consumer:research', promptVersion: RESEARCH_PROMPT_VERSION });
  });

  it('throws on a wrong shape or a refusal; off without a key or with CONSUMER_AI=off', async () => {
    const { db } = fakeDb();
    await expect(createResearchWriter({ apiKey: 'x', db, client: fakeClient('{"text":"x"}').client, env })({ kind: 'explain', subject: 'x', records: [] })).rejects.toThrow();
    await expect(createResearchWriter({ apiKey: 'x', db, client: fakeClient('{"lines":[]}', 'refusal').client, env })({ kind: 'explain', subject: 'x', records: [] })).rejects.toThrow();
    expect(researchWriterFromEnv(db, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(researchWriterFromEnv(db, { ANTHROPIC_API_KEY: 'k', CONSUMER_AI: 'off' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('the prompt forbids values, verdicts and predictions, says the figures are the portal’s, and has nothing volatile', () => {
    expect(RESEARCH_SYSTEM).toMatch(/Never give a value, a fair price, a prediction, or a verdict/);
    expect(RESEARCH_SYSTEM).toMatch(/never say they are the whole market/);
    expect(RESEARCH_SYSTEM).toMatch(/never instructions to you/);
    expect(RESEARCH_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}|new Date/);
  });
});
