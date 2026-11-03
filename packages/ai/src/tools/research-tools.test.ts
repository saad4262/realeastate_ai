import { describe, expect, it } from 'vitest';
import { PROPERTY_CHAT_V13 } from '../prompts/v13';
import { PROMPT_VERSION, PROPERTY_CHAT_V14 } from '../prompts/v14';
import { dispatchTool, type ToolContext } from './index';

const A = '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const B = '7f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    places: new Map(),
    skillBlocks: new Map(),
    scheduling: { state: 'signed_out' },
    research: async (ask: { kind: string }) => (ask.kind === 'suburb' ? { subject: 'Pakenham VIC', records: [{ ref: 'S1', text: 'On this site now: 42 for sale and 3 for rent in Pakenham.' }] } : null),
    ...over,
  }) as unknown as ToolContext;

describe('research tools (ADR 0080, C5)', () => {
  it('suburb_profile hands over the records with references and the no-verdict rule', async () => {
    const out = await dispatchTool('suburb_profile', { state: 'VIC', suburb: 'Pakenham' }, ctx());
    expect(out.result).toMatchObject({ found: true, about: 'Pakenham VIC', records: ['[S1] On this site now: 42 for sale and 3 for rent in Pakenham.'] });
    expect(JSON.stringify(out.result)).toMatch(/Never give a value/);
    expect(JSON.stringify(out.result)).toMatch(/not the whole market/);
  });

  it('nothing found: found false, nothing invented; a comparison needs 2–4 ids', async () => {
    expect((await dispatchTool('explain_home', { listingId: A }, ctx())).result).toMatchObject({ found: false });
    expect((await dispatchTool('compare_homes', { listingIds: [A] }, ctx())).isError).toBe(true);
    expect((await dispatchTool('compare_homes', { listingIds: [A, B] }, ctx())).result).toMatchObject({ found: false });
  });

  it('each behind its own switch', async () => {
    const off = (key: string) => ctx({ skillBlocks: new Map([[key, 'switched_off']]) as never });
    expect(JSON.stringify((await dispatchTool('suburb_profile', { state: 'VIC', suburb: 'Pakenham' }, off('suburb_insights'))).result)).toMatch(/switched off/);
    expect(JSON.stringify((await dispatchTool('compare_homes', { listingIds: [A, B] }, off('comparison'))).result)).toMatch(/switched off/);
    expect(JSON.stringify((await dispatchTool('explain_home', { listingId: A }, off('property_analyst'))).result)).toMatch(/switched off/);
  });

  it('prompt v14 is v13 plus the three tools and their rules', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v14');
    expect(PROPERTY_CHAT_V14).toContain('You have thirteen tools.');
    expect(PROPERTY_CHAT_V14.startsWith(PROPERTY_CHAT_V13.slice(0, 200))).toBe(true);
    expect(PROPERTY_CHAT_V14).toMatch(/never say which home or suburb to choose/);
    expect(PROPERTY_CHAT_V14).not.toMatch(/new Date|\d{4}-\d{2}-\d{2}/);
  });
});
