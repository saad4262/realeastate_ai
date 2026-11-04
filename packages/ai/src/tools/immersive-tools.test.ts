import { describe, expect, it } from 'vitest';
import { floorplanToolResult } from '@repo/core/media';
import { PROPERTY_CHAT_V17 } from '../prompts/v17';
import { PROMPT_VERSION, PROPERTY_CHAT_V18 } from '../prompts/v18';
import { dispatchTool, PROPERTY_CHAT_TOOLS, type ToolContext } from './index';

const L = '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    places: new Map(),
    skillBlocks: new Map(),
    scheduling: { state: 'signed_out' },
    floorplan: async (id: string) => (id === L ? floorplanToolResult(L, { floorplans: [{ id: 'f', url: 'https://cdn.test/f.png', width: null, height: null, rooms: ['kitchen', 'bedroom', 'study'] }], videos: [], tours: [] }) : null),
    ...over,
  }) as unknown as ToolContext;

describe('floorplan_rooms (ADR 0080, C9 decision 3)', () => {
  it('names the rooms, links the floorplan, and forbids sizes', async () => {
    const out = await dispatchTool('floorplan_rooms', { listingId: L }, ctx());
    expect(out.result).toMatchObject({ found: true, rooms: ['Kitchen', 'Bedrooms', 'Study'], page: `/listing/${L}#floorplan` });
    expect(JSON.stringify(out.result)).toMatch(/Never give a size/);
  });
  it('not public → found false; off → refused; a bad id refused', async () => {
    expect((await dispatchTool('floorplan_rooms', { listingId: '7f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c' }, ctx())).result).toMatchObject({ found: false });
    expect((await dispatchTool('floorplan_rooms', { listingId: L }, ctx({ skillBlocks: new Map([['immersive', 'switched_off']]) }))).isError).toBe(true);
    expect((await dispatchTool('floorplan_rooms', { listingId: 'x' }, ctx())).isError).toBe(true);
  });
});

describe('prompt v18', () => {
  it('builds on v17, counts twenty tools, forbids a size, and has no date', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v18');
    expect(PROPERTY_CHAT_V18.startsWith(PROPERTY_CHAT_V17.slice(0, 200))).toBe(true);
    expect(PROPERTY_CHAT_V18).toContain('You have twenty tools.');
    expect(PROPERTY_CHAT_TOOLS).toHaveLength(20);
    expect(PROPERTY_CHAT_V18).toMatch(/Never give a size, a dimension, an area or a floor space/);
    expect(PROPERTY_CHAT_V18).not.toMatch(/new Date|\d{4}-\d{2}-\d{2}/);
  });
});
