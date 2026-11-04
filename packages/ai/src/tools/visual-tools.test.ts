import { describe, expect, it } from 'vitest';
import { lookToolResult, type LookAsk } from '@repo/core/visual-search';
import { PROPERTY_CHAT_V19 } from '../prompts/v19';
import { PROMPT_VERSION, PROPERTY_CHAT_V20 } from '../prompts/v20';
import { dispatchTool, PROPERTY_CHAT_TOOLS, type ToolContext } from './index';

const seen: LookAsk[] = [];
const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    places: new Map(),
    skillBlocks: new Map(),
    scheduling: { state: 'signed_out' },
    visualSearch: async (ask: LookAsk) => {
      seen.push(ask);
      return lookToolResult({ status: 'filling_up', photos: 1, searchable: 0, threshold: 500 }, '/look');
    },
    ...over,
  }) as unknown as ToolContext;

describe('homes_that_look_like (ADR 0080, C9 decisions 9–12)', () => {
  it('words with filters reach core parsed; the result says it is still filling up', async () => {
    const out = await dispatchTool('homes_that_look_like', { words: 'light-filled kitchen, timber floors', suburbs: ['Officer'], priceTo: 800000, bedrooms: 3 }, ctx());
    expect(seen.at(-1)).toMatchObject({ words: 'light-filled kitchen, timber floors', channel: 'sale', suburbs: ['Officer'], priceTo: 800000, bedrooms: 3 });
    expect(out.result).toMatchObject({ found: false });
    expect(JSON.stringify(out.result)).toMatch(/still filling up: 0 searchable photos/);
  });
  it('off → refused; neither or both, an upload field or junk → refused', async () => {
    expect((await dispatchTool('homes_that_look_like', { words: 'timber floors' }, ctx({ skillBlocks: new Map([['visual_search', 'switched_off']]) }))).isError).toBe(true);
    expect((await dispatchTool('homes_that_look_like', {}, ctx())).isError).toBe(true);
    expect((await dispatchTool('homes_that_look_like', { words: 'timber floors', photoId: '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c' }, ctx())).isError).toBe(true);
    expect((await dispatchTool('homes_that_look_like', { imageUrl: 'https://x/me.jpg' }, ctx())).isError).toBe(true);
    expect((await dispatchTool('homes_that_look_like', { photoId: 'x' }, ctx())).isError).toBe(true);
  });
});

describe('prompt v20', () => {
  it('builds on v19, counts twenty-two tools, forbids judging a home, and has no date', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v20');
    expect(PROPERTY_CHAT_V20.startsWith(PROPERTY_CHAT_V19.slice(0, 200))).toBe(true);
    expect(PROPERTY_CHAT_V20).toContain('You have twenty-two tools.');
    expect(PROPERTY_CHAT_TOOLS).toHaveLength(22);
    expect(PROPERTY_CHAT_V20).toMatch(/never give a score, a percentage or a "match"/);
    expect(PROPERTY_CHAT_V20).toMatch(/Never offer to look at a photo of their own/);
    expect(PROPERTY_CHAT_V20).not.toMatch(/new Date|\d{4}-\d{2}-\d{2}/);
  });
});
