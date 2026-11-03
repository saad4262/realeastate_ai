import { describe, expect, it } from 'vitest';
import { PROPERTY_CHAT_V12 } from '../prompts/v12';
import { PROMPT_VERSION, PROPERTY_CHAT_V13 } from '../prompts/v13';
import { dispatchTool, PROPERTY_CHAT_TOOLS, type ToolContext } from './index';
import { RENOVATION_CATEGORY_KEYS } from '@repo/core/renovation/categories';

const ID = '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ places: new Map(), skillBlocks: new Map(), scheduling: { state: 'signed_out' }, getListing: async (id: string) => (id === ID ? { id: ID, state: 'QLD' } : null), ...over }) as unknown as ToolContext;

describe('renovation_plan (ADR 0080, C3)', () => {
  it('the schema offers exactly the fixed kinds of work', () => {
    const tool = PROPERTY_CHAT_TOOLS.find((t) => t.name === 'renovation_plan')!;
    const items = (tool.input_schema as { properties: { categories: { items: { enum: string[] } } } }).properties.categories.items.enum;
    expect(items).toEqual([...RENOVATION_CATEGORY_KEYS]);
  });

  it('returns our drivers, trades and the state’s permit notes with sources — and no figure', async () => {
    const out = await dispatchTool('renovation_plan', { categories: ['remove_wall', 'deck'], state: 'VIC' }, ctx());
    const r = out.result as { state: string; work: { kind: string; trades: string[] }[]; permits: { about: string; source?: string; notVerified?: true }[] };
    expect(r.state).toBe('VIC');
    expect(r.work.map((w) => w.kind)).toEqual(['Removing a wall', 'Deck']);
    expect(r.permits.find((p) => p.about === 'Structural work')?.source).toMatch(/Building and Plumbing Commission/);
    expect(r.permits.find((p) => p.about === 'Units and owners corporations')).toMatchObject({ notVerified: true });
    expect(JSON.stringify(out.result)).not.toMatch(/\$\d/);
  });

  it('a listing’s state wins over the one the guide passed', async () => {
    const out = await dispatchTool('renovation_plan', { categories: ['pool'], state: 'VIC', listingId: ID }, ctx());
    expect(out.result).toMatchObject({ state: 'QLD' });
  });

  it('refuses a kind of work outside the list, so the guide must pick again', async () => {
    const out = await dispatchTool('renovation_plan', { categories: ['granny_flat'] }, ctx());
    expect(out.isError).toBe(true);
  });

  it('is behind the Renovation AI switch', async () => {
    const out = await dispatchTool('renovation_plan', { categories: ['kitchen'], state: 'NSW' }, ctx({ skillBlocks: new Map([['renovation', 'switched_off']]) }));
    expect(JSON.stringify(out.result)).toMatch(/switched off in your Skills/);
  });

  it('prompt v13 is v12 plus the tool and its rules', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v13');
    expect(PROPERTY_CHAT_V13).toContain('You have ten tools.');
    expect(PROPERTY_CHAT_V13.startsWith(PROPERTY_CHAT_V12.slice(0, 200))).toBe(true);
    expect(PROPERTY_CHAT_V13).toMatch(/Never give a price/);
    expect(PROPERTY_CHAT_V13).not.toMatch(/new Date|\d{4}-\d{2}-\d{2}/);
  });
});
