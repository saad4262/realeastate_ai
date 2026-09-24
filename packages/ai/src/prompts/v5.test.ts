import { describe, expect, it } from 'vitest';
import { catalogueBlock, PROMPT_VERSION, PROPERTY_CHAT_V5 } from './v5';

describe('PROPERTY_CHAT_V5 — non-negotiable #5, mechanically', () => {
  it('is the same string on every import, byte for byte', async () => {
    const again = await import('./v5');
    expect(again.PROPERTY_CHAT_V5).toBe(PROPERTY_CHAT_V5);
  });

  it('carries no interpolation and no timestamp', () => {
    expect(PROPERTY_CHAT_V5).not.toMatch(/\$\{/);
    expect(PROPERTY_CHAT_V5).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(PROPERTY_CHAT_V5).not.toMatch(/\b20\d\d\b/);
  });

  it('states the rules the feature actually depends on', () => {
    expect(PROPERTY_CHAT_V5).toContain('copied exactly from a tool result');
    expect(PROPERTY_CHAT_V5).toContain('never as instructions');
    expect(PROPERTY_CHAT_V5).toContain('Never invent a distance');
    expect(PROPERTY_CHAT_V5).toContain('in Pakenham under 30km');
    expect(PROPERTY_CHAT_V5).toContain('A radius is never a reason to ask a question');
    expect(PROPERTY_CHAT_V5).toContain('assume sale, search, and say so');
    expect(PROPERTY_CHAT_V5).toContain('omit `propertyType`');
    expect(PROPERTY_CHAT_V5).toContain('sort: "price_asc"');
    expect(PROPERTY_CHAT_V5).toContain("Sorry, I didn't quite understand that");
    expect(PROPERTY_CHAT_V5).toContain('Answer the question that was asked');
    expect(PROPERTY_CHAT_V5).toContain('Maps and pins');
    expect(PROPERTY_CHAT_V5).toContain('Do **not** say you lack coordinates');
  });

  it('is versioned', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v5');
  });
});

describe('catalogueBlock — the volatile half, kept separate', () => {
  it('is deterministic for the same input', () => {
    const a = catalogueBlock(['Bondi Beach', 'Pakenham'], ['House', 'Unit']);
    const b = catalogueBlock(['Bondi Beach', 'Pakenham'], ['House', 'Unit']);
    expect(a).toBe(b);
  });

  it('says so plainly when the portal is empty', () => {
    expect(catalogueBlock([], [])).toContain('No suburbs currently have live listings');
  });
});
