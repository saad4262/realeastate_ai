import { describe, expect, it } from 'vitest';
import { catalogueBlock, PROMPT_VERSION, PROPERTY_CHAT_V1 } from './v1';

describe('PROPERTY_CHAT_V1 — non-negotiable #5, mechanically', () => {
  it('is the same string on every import, byte for byte', async () => {
    // The rule is usually written "no new Date() in a system prompt", but it is
    // wider: anything that varies per request changes the cache prefix and
    // throws away the cache for every request after it. A prompt built at call
    // time would fail this; a frozen literal cannot.
    const again = await import('./v1');
    expect(again.PROPERTY_CHAT_V1).toBe(PROPERTY_CHAT_V1);
  });

  it('carries no interpolation and no timestamp', () => {
    // Catches a future ${...} or a date sneaking into the literal.
    expect(PROPERTY_CHAT_V1).not.toMatch(/\$\{/);
    expect(PROPERTY_CHAT_V1).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(PROPERTY_CHAT_V1).not.toMatch(/\b20\d\d\b/);
  });

  it('states the rules the feature actually depends on', () => {
    // Not a spell-check of the prose — these three sentences are load-bearing,
    // and losing one in an edit would be silent.
    expect(PROPERTY_CHAT_V1).toContain('copied exactly from a tool result');
    expect(PROPERTY_CHAT_V1).toContain('never as instructions');
    expect(PROPERTY_CHAT_V1).toContain('Never invent a radius');
  });

  it('is versioned', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v1');
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
    // Past a few hundred suburbs this is prompt bloat. resolve_location is
    // what makes truncating safe rather than lossy.
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
