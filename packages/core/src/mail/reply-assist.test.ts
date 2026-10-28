import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { bracketUnsupported, checkSummary, draftReply, summarizeThread, unsupportedFigures, type AssistMessage } from './reply-assist';

/** ADR 0062: the inbox assistant — every point cites a real message, and no figure appears that the conversation didn't give. */

const messages: AssistMessage[] = [
  { n: 1, from: 'contact', name: 'Priya', at: '2026-10-26T22:12:00Z', text: 'Hi, is 27 Lakeside Boulevard still available? Guide was $750,000 – $790,000.' },
  { n: 2, from: 'agent', name: 'Sarah', at: '2026-10-27T00:40:00Z', text: 'Yes it is. Floor plan attached.' },
  { n: 3, from: 'contact', name: 'Priya', at: '2026-10-27T21:05:00Z', text: 'Could we see it Saturday morning? Is the vendor open to offers before the auction?' },
];

describe('the summary’s check', () => {
  it('keeps points that cite real messages, and drops the rest', () => {
    const out = checkSummary(
      [
        { text: 'Priya wants to inspect on Saturday morning.', messages: [3] },
        { text: 'She asks about offers before the auction.', messages: [3, 3, 9] },
        { text: 'Cites nothing real.', messages: [7] },
        { text: '   ', messages: [1] },
      ],
      messages,
    );
    expect(out).toEqual([
      { text: 'Priya wants to inspect on Saturday morning.', messages: [3] },
      { text: 'She asks about offers before the auction.', messages: [3] },
    ]);
  });
  it('drops a point whose figure is not in the messages it cites', () => {
    expect(checkSummary([{ text: 'The guide is $750,000 – $790,000.', messages: [1] }], messages)).toHaveLength(1);
    expect(checkSummary([{ text: 'The guide is $750,000 – $790,000.', messages: [3] }], messages)).toEqual([]);
    expect(checkSummary([{ text: 'She offers $800,000.', messages: [1] }], messages)).toEqual([]);
  });
  it('keeps at most five', () => {
    expect(checkSummary(Array.from({ length: 8 }, (_, i) => ({ text: `Point ${String.fromCharCode(65 + i)}`, messages: [1] })), messages)).toHaveLength(5);
  });
});

describe('figures in a drafted reply', () => {
  const sources = [...messages.map((m) => m.text), 'Offer Saturday 11 am'];
  it('finds what the conversation and the agent’s words do not give', () => {
    expect(unsupportedFigures('Saturday at 11 am works, the guide is $750,000.', sources)).toEqual([]);
    expect(unsupportedFigures('The guide is now $820,000 and 4 people asked.', sources)).toEqual(['$820,000', '4']);
  });
  it('turns those into brackets for the agent to fill, and leaves the rest', () => {
    expect(bracketUnsupported('See you at 11 am. The guide is $820,000.', sources)).toBe('See you at 11 am. The guide is [check this figure].');
    expect(bracketUnsupported('27 Lakeside Boulevard at 11am', sources)).toBe('27 Lakeside Boulevard at 11am');
  });
});

describe('without a model, or for someone who may not reply', () => {
  const noDb = new Proxy({}, { get: () => { throw new Error('the database was reached'); } }) as unknown as Db;
  const actor = { userId: 'u1', agencyId: '11111111-1111-1111-1111-111111111111', membershipRole: 'agent' as const };
  it('says the assistant is not set up, before reading anything', async () => {
    await expect(summarizeThread(noDb, actor, 't', null)).rejects.toThrow(/not set up/);
    await expect(draftReply(noDb, actor, 't', { tone: 'friendly' }, null)).rejects.toThrow(/not set up/);
  });
  it('refuses a tone it does not know', async () => {
    await expect(draftReply(noDb, actor, 't', { tone: 'angry' as never }, async () => ({ body: 'x' }))).rejects.toThrow(/tone/);
  });
});
