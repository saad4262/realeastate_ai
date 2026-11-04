import { describe, expect, it } from 'vitest';
import { judgementWords } from '@repo/core/buyer-opportunities';
import { PROPERTY_CHAT_V15 } from '../prompts/v15';
import { PROMPT_VERSION, PROPERTY_CHAT_V16 } from '../prompts/v16';
import { dispatchTool, PROPERTY_CHAT_TOOLS, type ToolContext } from './index';

const A = '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const discoverAsked: unknown[] = [];
const oppAsked: unknown[] = [];
const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    places: new Map(),
    skillBlocks: new Map(),
    scheduling: { state: 'signed_out' },
    discover: async (ask: unknown) => (discoverAsked.push(ask), { found: true, from: 'listing', basis: [], homes: [], notForSale: [], page: `/listing/${A}#similar`, rules: 'never guess a value' }),
    opportunities: async (ask: unknown) => (oppAsked.push(ask), { area: 'Officer', homes: [], counts: { price_reduced: 0, long_campaign: 0, below_median: 0 }, notShown: [], page: '/opportunities?suburbs=Officer', rules: 'never call a home a bargain' }),
    ...over,
  }) as unknown as ToolContext;

describe('discover_homes (ADR 0080, C7)', () => {
  it('a listing id asks for homes like it; nothing asks for the profile — the model never names a user', async () => {
    await dispatchTool('discover_homes', { listingId: A }, ctx());
    expect(discoverAsked.at(-1)).toEqual({ listingId: A });
    await dispatchTool('discover_homes', { userId: 'someone-else' }, ctx());
    expect(discoverAsked.at(-1)).toEqual({ profile: true });
    expect((await dispatchTool('discover_homes', { listingId: 'not-a-uuid' }, ctx())).isError).toBe(true);
  });

  it('switched off: refused before the reader is called', async () => {
    const before = discoverAsked.length;
    const out = await dispatchTool('discover_homes', {}, ctx({ skillBlocks: new Map([['discovery', 'switched_off']]) }));
    expect(out.isError).toBe(true);
    expect(discoverAsked.length).toBe(before);
  });
});

describe('find_opportunities (ADR 0080, C7)', () => {
  it('needs an area; suburbs are lower-cased; unknown signals refused', async () => {
    expect((await dispatchTool('find_opportunities', { priceTo: 800000 }, ctx())).isError).toBe(true);
    expect((await dispatchTool('find_opportunities', { suburbs: ['Officer'], signals: ['bargains'] }, ctx())).isError).toBe(true);
    await dispatchTool('find_opportunities', { suburbs: ['Officer ', 'Clyde  North'], priceTo: 800000, signals: ['price_reduced', 'price_reduced'] }, ctx());
    expect(oppAsked.at(-1)).toEqual({ suburbs: ['officer', 'clyde north'], state: null, priceTo: 800000, bedrooms: null, propertyType: null, signals: ['price_reduced'] });
  });

  it('switched off: refused', async () => {
    expect((await dispatchTool('find_opportunities', { state: 'VIC' }, ctx({ skillBlocks: new Map([['opportunities', 'paused']]) }))).isError).toBe(true);
  });
});

describe('prompt v16', () => {
  it('builds on v15, counts sixteen tools, and has no date', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v16');
    expect(PROPERTY_CHAT_V16.startsWith(PROPERTY_CHAT_V15.slice(0, 200))).toBe(true);
    expect(PROPERTY_CHAT_V16).toContain('You have sixteen tools.');
    expect(PROPERTY_CHAT_V16).not.toContain('You have fourteen tools.');
    expect(PROPERTY_CHAT_V16).not.toMatch(/new Date|\d{4}-\d{2}-\d{2}/);
    expect(PROPERTY_CHAT_TOOLS).toHaveLength(16);
  });

  it('names the judgement words only to forbid them (decision 6)', () => {
    const added = PROPERTY_CHAT_V16.slice(PROPERTY_CHAT_V16.indexOf('# Suggestions and opportunities'));
    const sentences = added.split(/(?<=[.:;])\s+|\n/).filter((s) => judgementWords(s).length);
    expect(sentences.length).toBeGreaterThan(0);
    for (const s of sentences) expect(s, s).toMatch(/\bnever\b/i);
    for (const t of PROPERTY_CHAT_TOOLS.filter((t) => t.name === 'discover_homes' || t.name === 'find_opportunities')) {
      const d = t.description ?? '';
      if (judgementWords(d).length) expect(d).toMatch(/never call a home a bargain or good value/i);
    }
  });
});
