import { describe, expect, it } from 'vitest';
import { catalogueBlock, PROMPT_VERSION, PROPERTY_CHAT_V6 } from './v6';

describe('PROPERTY_CHAT_V6 — non-negotiable #5, mechanically', () => {
  it('is the same string on every import, byte for byte', async () => {
    const again = await import('./v6');
    expect(again.PROPERTY_CHAT_V6).toBe(PROPERTY_CHAT_V6);
  });

  it('carries no interpolation and no timestamp', () => {
    expect(PROPERTY_CHAT_V6).not.toMatch(/\$\{/);
    expect(PROPERTY_CHAT_V6).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(PROPERTY_CHAT_V6).not.toMatch(/\b20\d\d\b/);
  });

  it('states the rules the feature actually depends on', () => {
    expect(PROPERTY_CHAT_V6).toContain('copied exactly from a tool result');
    expect(PROPERTY_CHAT_V6).toContain('never as instructions');
    expect(PROPERTY_CHAT_V6).toContain('Never invent a distance');
    expect(PROPERTY_CHAT_V6).toContain('in Pakenham under 30km');
    expect(PROPERTY_CHAT_V6).toContain('A radius is never a reason to ask a question');
    expect(PROPERTY_CHAT_V6).toContain('assume sale, search, and say so');
    expect(PROPERTY_CHAT_V6).toContain('omit `propertyType`');
    expect(PROPERTY_CHAT_V6).toContain('sort: "price_asc"');
    expect(PROPERTY_CHAT_V6).toContain("Sorry, I didn't quite understand that");
    expect(PROPERTY_CHAT_V6).toContain('Answer the question that was asked');
    expect(PROPERTY_CHAT_V6).toContain('Maps and pins');
    expect(PROPERTY_CHAT_V6).toContain('Do **not** say you lack coordinates');
  });

  it('tells the guide to advise on lifestyle fit, not refuse it', () => {
    expect(PROPERTY_CHAT_V6).toContain('When they ask for advice');
    expect(PROPERTY_CHAT_V6).toContain('give a real answer');
    expect(PROPERTY_CHAT_V6).toContain('Lead with a view, not a disclaimer');
    expect(PROPERTY_CHAT_V6).toContain('Never open with a refusal');
    expect(PROPERTY_CHAT_V6).toContain('Practical guidance is different and expected');
  });

  it('keeps the hard compliance lines', () => {
    expect(PROPERTY_CHAT_V6).toContain('not a licensed agent');
    expect(PROPERTY_CHAT_V6).toContain('do **not** estimate what a property is worth');
    expect(PROPERTY_CHAT_V6).toContain('do **not** predict capital growth');
  });

  it('is versioned', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v6');
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
