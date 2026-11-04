import { describe, expect, it } from 'vitest';
import { landAndZoning, landAndZoningToolResult } from '@repo/core/development';
import { PROPERTY_CHAT_V18 } from '../prompts/v18';
import { PROMPT_VERSION, PROPERTY_CHAT_V19 } from '../prompts/v19';
import { dispatchTool, PROPERTY_CHAT_TOOLS, type ToolContext } from './index';

const L = '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const P = '7a1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
const panel = landAndZoning(
  { propertyId: P, state: 'VIC', at: { lat: -38.07, lng: 145.48 }, landAreaSqm: 612 },
  { status: 'found', zones: [{ code: 'GRZ1', name: 'General Residential Zone - Schedule 1', council: 'Cardinia', plan: null }], source: { name: 'Vicmap Planning', licence: 'CC BY 4.0', url: 'https://x' }, asOf: '2026-11-04', asOfKind: 'checked' },
);
const seen: unknown[] = [];
const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({
    places: new Map(),
    skillBlocks: new Map(),
    scheduling: { state: 'signed_out' },
    development: async (ref: { listingId?: string; propertyId?: string }) => {
      seen.push(ref);
      return ref.listingId === L || ref.propertyId === P ? landAndZoningToolResult('14 Example Road, Officer', `/property/${P}#land`, panel) : null;
    },
    ...over,
  }) as unknown as ToolContext;

describe('land_and_zoning (ADR 0080, C9 decisions 4–6)', () => {
  it('a listing or an address not for sale: the zone, the land size, the questions and the rules', async () => {
    const out = await dispatchTool('land_and_zoning', { listingId: L }, ctx());
    expect(out.result).toMatchObject({ zoning: { found: true, zones: [{ zone: 'General Residential Zone - Schedule 1 (GRZ1)' }] }, landAreaSqm: 612 });
    expect(JSON.stringify(out.result)).toMatch(/Never say whether the land can be subdivided/);
    expect((await dispatchTool('land_and_zoning', { propertyId: P }, ctx())).result).toMatchObject({ zoning: { found: true } });
    expect(seen).toEqual([{ listingId: L }, { propertyId: P }]);
  });
  it('not public → found false; off → refused; neither or both ids → refused', async () => {
    expect((await dispatchTool('land_and_zoning', { listingId: '9f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c' }, ctx())).result).toMatchObject({ found: false });
    expect((await dispatchTool('land_and_zoning', { listingId: L }, ctx({ skillBlocks: new Map([['development', 'switched_off']]) }))).isError).toBe(true);
    expect((await dispatchTool('land_and_zoning', {}, ctx())).isError).toBe(true);
    expect((await dispatchTool('land_and_zoning', { listingId: L, propertyId: P }, ctx())).isError).toBe(true);
    expect((await dispatchTool('land_and_zoning', { listingId: 'x' }, ctx())).isError).toBe(true);
  });
});

describe('prompt v19', () => {
  it('builds on v18, counts twenty-one tools, forbids advice, and has no date', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v19');
    expect(PROPERTY_CHAT_V19.startsWith(PROPERTY_CHAT_V18.slice(0, 200))).toBe(true);
    expect(PROPERTY_CHAT_V19).toContain('You have twenty-one tools.');
    expect(PROPERTY_CHAT_TOOLS.length).toBeGreaterThanOrEqual(21); // C9 adds homes_that_look_like (v20)
    expect(PROPERTY_CHAT_V19).toMatch(/The zone is not a permission\. Never say the land can or cannot be subdivided/);
    expect(PROPERTY_CHAT_V19).toMatch(/Never name a zone of your own/);
    expect(PROPERTY_CHAT_V19).not.toMatch(/new Date|\d{4}-\d{2}-\d{2}/);
  });
});
