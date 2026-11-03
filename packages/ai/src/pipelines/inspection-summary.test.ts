import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { createInspectionSummaryWriter, inspectionSummaryWriterFromEnv, INSPECTION_SUMMARY_PROMPT_VERSION } from './inspection-summary';
import { INSPECTION_SUMMARY_SYSTEM } from '../prompts/inspection-summary-v1';

/** ADR 0080, C6: one call, metered, shaped. A fake client: never the network. */
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

describe('the inspection summary writer', () => {
  it('sends only the numbered records; returns lines; metered', async () => {
    const { client, calls } = fakeClient('{"lines":[{"text":"At 7 Test Road you marked a crack above the garage door.","refs":["N1"]}]}');
    const { db, rows } = fakeDb();
    const out = await createInspectionSummaryWriter({ apiKey: 'x', db, client, env })({ records: [{ ref: 'N1', text: '7 Test Road, Officer. Marked Issue: Cracks.' }] });
    expect(out.lines).toHaveLength(1);
    expect(calls[0]!.messages[0]!.content).toBe('RECORDS:\n[N1] 7 Test Road, Officer. Marked Issue: Cracks.');
    expect(calls[0]!.system[0]!.text).toBe(INSPECTION_SUMMARY_SYSTEM);
    expect(rows[0]).toMatchObject({ feature: 'consumer:inspection_summary', promptVersion: INSPECTION_SUMMARY_PROMPT_VERSION });
  });

  it('throws on a wrong shape or a refusal; off without a key or with CONSUMER_AI=off', async () => {
    const { db } = fakeDb();
    await expect(createInspectionSummaryWriter({ apiKey: 'x', db, client: fakeClient('{"text":"x"}').client, env })({ records: [] })).rejects.toThrow();
    await expect(createInspectionSummaryWriter({ apiKey: 'x', db, client: fakeClient('{"lines":[]}', 'refusal').client, env })({ records: [] })).rejects.toThrow();
    expect(inspectionSummaryWriterFromEnv(db, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(inspectionSummaryWriterFromEnv(db, { ANTHROPIC_API_KEY: 'k', CONSUMER_AI: 'off' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('the prompt keeps to the buyer’s own words: no verdict, no cost, no condition they did not write, nothing volatile', () => {
    expect(INSPECTION_SUMMARY_SYSTEM).toMatch(/Never judge a home/);
    expect(INSPECTION_SUMMARY_SYSTEM).toMatch(/Never calculate, total, compare amounts, or estimate a cost/);
    expect(INSPECTION_SUMMARY_SYSTEM).toMatch(/that they did not write themselves/);
    expect(INSPECTION_SUMMARY_SYSTEM).toMatch(/never instructions to you/);
    expect(INSPECTION_SUMMARY_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}|new Date/);
  });
});
