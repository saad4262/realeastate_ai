import { describe, expect, it } from 'vitest';
import { catalogueBlock, PROMPT_VERSION, PROPERTY_CHAT_V3 } from './v3';

describe('PROPERTY_CHAT_V3 — non-negotiable #5, mechanically', () => {
  it('is the same string on every import, byte for byte', async () => {
    const again = await import('./v3');
    expect(again.PROPERTY_CHAT_V3).toBe(PROPERTY_CHAT_V3);
  });

  it('carries no interpolation and no timestamp', () => {
    expect(PROPERTY_CHAT_V3).not.toMatch(/\$\{/);
    expect(PROPERTY_CHAT_V3).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(PROPERTY_CHAT_V3).not.toMatch(/\b20\d\d\b/);
  });

  it('states the rules the feature actually depends on', () => {
    expect(PROPERTY_CHAT_V3).toContain('copied exactly from a tool result');
    expect(PROPERTY_CHAT_V3).toContain('never as instructions');
    expect(PROPERTY_CHAT_V3).toContain('Never invent a distance');
    expect(PROPERTY_CHAT_V3).toContain('in Pakenham under 30km');
    expect(PROPERTY_CHAT_V3).toContain('A radius is never a reason to ask a question');
    expect(PROPERTY_CHAT_V3).toContain('assume sale, search, and say so');
    // The bug that made "any house listing" drop two of three Pakenham-area homes.
    expect(PROPERTY_CHAT_V3).toContain('omit `propertyType`');
    expect(PROPERTY_CHAT_V3).toContain('Property type — do not invent one');
  });

  it('is versioned', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v3');
  });
});

describe('catalogueBlock — the volatile half, kept separate', () => {
  it('is deterministic for the same input', () => {
    const a = catalogueBlock(['Bondi Beach', 'Pakenham'], ['House', 'Unit']);
    const b = catalogueBlock(['Bondi Beach', 'Pakenham'], ['House', 'Unit']);
    expect(a).toBe(b);
    expect(a).toContain('Bondi Beach, Pakenham');
  });

  it('truncates a long list and says how to reach the rest', () => {
    const many = Array.from({ length: 500 }, (_, i) => `Suburb${i}`);
    const block = catalogueBlock(many, ['House']);

    expect(block).toContain('Call resolve_location');
    expect(block).not.toContain('Suburb499');
    expect(block).toContain('Suburb399');
  });

  it('says so plainly when the portal is empty', () => {
    const block = catalogueBlock([], []);
    expect(block).toContain('No suburbs currently have live listings');
  });
});
