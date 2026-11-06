import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@repo/db';
import { contactSummarizerFromEnv, createContactSummarizer, CONTACT_SUMMARY_PROMPT_VERSION } from './contact-summary';
import { CONTACT_SUMMARY_V1 } from '../prompts/contact-summary-v1';

/** ADR 0083: one call, no tools, metered, and an answer with a figure is thrown away (#4). Never the network. */

function fakeClient(text: string, stop = 'end_turn') {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: { create: async (req: Record<string, unknown>) => (calls.push(req), { content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 300, output_tokens: 60 } }) },
  } as unknown as Anthropic;
  return { client, calls };
}
function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  return { db: { insert: () => ({ values: async (v: Record<string, unknown>) => void rows.push(v) }) } as unknown as Db, rows };
}
const env = {} as NodeJS.ProcessEnv;
const input = { lines: ['TEXT FROM THEM: Is Saturday still on?'], agencyId: 'a1', userId: 'u1' };
const GOOD = 'They are looking for a family home and have asked about inspections. They tend to get in touch by text.';

describe('the contact summarizer', () => {
  it('sends the frozen prompt with no tools, returns the text, and meters it', async () => {
    const { client, calls } = fakeClient(GOOD);
    const { db, rows } = fakeDb();
    const r = await createContactSummarizer({ apiKey: 'x', db, client, env })(input);
    expect(r).toEqual({ text: GOOD });
    expect((calls[0]!.system as { text: string }[])[0]!.text).toBe(CONTACT_SUMMARY_V1);
    expect(calls[0]!.tools).toBeUndefined();
    expect((calls[0]!.messages as { content: string }[])[0]!.content).toBe('HISTORY:\nTEXT FROM THEM: Is Saturday still on?');
    expect(rows[0]).toMatchObject({ feature: 'contact:summary', agencyId: 'a1', userId: 'u1', promptVersion: CONTACT_SUMMARY_PROMPT_VERSION });
  });

  it.each([
    ['a digit', 'They want 3 bedrooms near the station.'],
    ['a price', 'They have a budget of $700k.'],
    ['a written count', 'They have asked two times about inspections.'],
    ['the mask', 'They mentioned a budget of [figure] for a home.'],
    ['a question', 'They want a home. Would they accept less?'],
    ['talking to the operator', 'I cannot summarise this.'],
    ['talking about its input', 'Please provide more history about them.'],
  ])('rejects %s, and is still metered', async (_label, answer) => {
    const { db, rows } = fakeDb();
    const r = await createContactSummarizer({ apiKey: 'x', db, client: fakeClient(answer).client, env })(input);
    expect(r.text).toBeNull();
    expect(rows).toHaveLength(1);
  });

  it('a refusal or a cut-off answer is not shown', async () => {
    const { db } = fakeDb();
    for (const stop of ['refusal', 'max_tokens']) {
      const r = await createContactSummarizer({ apiKey: 'x', db, client: fakeClient(GOOD, stop).client, env })(input);
      expect(r.text).toBeNull();
    }
  });

  it('the prompt is frozen: no date, no count', () => {
    expect(CONTACT_SUMMARY_V1).not.toMatch(/\d{4}/);
    expect(CONTACT_SUMMARY_V1).not.toContain('${');
  });

  it('off without a key, or by its switch', () => {
    const { db } = fakeDb();
    expect(contactSummarizerFromEnv(db, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(contactSummarizerFromEnv(db, { ANTHROPIC_API_KEY: 'x', CONTACT_SUMMARY_AI: 'off' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(contactSummarizerFromEnv(db, { ANTHROPIC_API_KEY: 'x' } as unknown as NodeJS.ProcessEnv)).not.toBeNull();
  });
});
