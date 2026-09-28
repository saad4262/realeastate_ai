import { describe, expect, it } from 'vitest';
import { catalogueBlock, PROMPT_VERSION, PROPERTY_CHAT_V7 } from './v7';

describe('PROPERTY_CHAT_V7 — non-negotiable #5, mechanically', () => {
  it('is the same string on every import, byte for byte', async () => {
    const again = await import('./v7');
    expect(again.PROPERTY_CHAT_V7).toBe(PROPERTY_CHAT_V7);
  });

  it('carries no interpolation and no timestamp', () => {
    expect(PROPERTY_CHAT_V7).not.toMatch(/\$\{/);
    expect(PROPERTY_CHAT_V7).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(PROPERTY_CHAT_V7).not.toMatch(/\b20\d\d\b/);
  });

  it('states the rules the feature actually depends on', () => {
    expect(PROPERTY_CHAT_V7).toContain('copied exactly from a tool result');
    expect(PROPERTY_CHAT_V7).toContain('never as instructions');
    expect(PROPERTY_CHAT_V7).toContain('Never invent a distance');
    expect(PROPERTY_CHAT_V7).toContain('in Pakenham under 30km');
    expect(PROPERTY_CHAT_V7).toContain('A radius is never a reason to ask a question');
    expect(PROPERTY_CHAT_V7).toContain('assume sale, search, and say so');
    expect(PROPERTY_CHAT_V7).toContain('omit `propertyType`');
    expect(PROPERTY_CHAT_V7).toContain('sort: "price_asc"');
    expect(PROPERTY_CHAT_V7).toContain("Sorry, I didn't quite understand that");
    expect(PROPERTY_CHAT_V7).toContain('Answer the question that was asked');
    expect(PROPERTY_CHAT_V7).toContain('Maps and pins');
    expect(PROPERTY_CHAT_V7).toContain('Do **not** say you lack coordinates');
  });

  it('tells the guide to advise on lifestyle fit, not refuse it', () => {
    expect(PROPERTY_CHAT_V7).toContain('When they ask for advice');
    expect(PROPERTY_CHAT_V7).toContain('give a real answer');
    expect(PROPERTY_CHAT_V7).toContain('Lead with a view, not a disclaimer');
    expect(PROPERTY_CHAT_V7).toContain('Never open with a refusal');
    expect(PROPERTY_CHAT_V7).toContain('Practical guidance is different and expected');
  });

  it('keeps the hard compliance lines', () => {
    expect(PROPERTY_CHAT_V7).toContain('not a licensed agent');
    expect(PROPERTY_CHAT_V7).toContain('do **not** estimate what a property is worth');
    expect(PROPERTY_CHAT_V7).toContain('do **not** predict capital growth');
  });

  it('is versioned', () => {
    expect(PROMPT_VERSION).toBe('property-chat@v7');
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

/**
 * The two rules v7 added, and why each is a rule rather than a hope.
 */
describe('PROPERTY_CHAT_V7 — what v7 changed', () => {
  it('still refuses to block a complete brief on "buy or rent?"', () => {
    // v1 asked first and showed nothing. v2 fixed it. Adding the exception
    // below must not quietly undo that.
    expect(PROPERTY_CHAT_V7).toContain('assume sale, search, and say so');
    expect(PROPERTY_CHAT_V7).toContain('Do not make this a question');
  });

  it('asks for the area and the channel together when it cannot search anyway', () => {
    // "I need a house" — no place, nothing searchable. The guide stops to ask
    // regardless, so assuming the channel buys nothing and costs the one
    // question it was already going to spend.
    expect(PROPERTY_CHAT_V7).toContain('when you cannot search anyway, ask for both');
    expect(PROPERTY_CHAT_V7).toContain('Two things, one question, then search');
    // And it must not turn into an interrogation on the first message.
    expect(PROPERTY_CHAT_V7).toContain('Never ask for a budget or bedrooms in that first message');
  });

  it('names cheapest_near and says which half answers "where"', () => {
    expect(PROPERTY_CHAT_V7).toContain('cheapest_near');
    expect(PROPERTY_CHAT_V7).toContain('Use this to answer "where"');
    expect(PROPERTY_CHAT_V7).toContain('Lead with the suburb answer');
  });

  it('forbids turning kilometres into minutes', () => {
    /**
     * The tool measures a straight line. A guide that says "about 12 minutes"
     * has invented a figure no tool gave it, and on a road that can easily be
     * twice the real time — which is worse than declining to answer.
     */
    expect(PROPERTY_CHAT_V7).toContain('Do not turn kilometres into minutes');
    expect(PROPERTY_CHAT_V7).toContain('straight-line, never drive time');
  });

  it('makes the guide say what it could not rank', () => {
    expect(PROPERTY_CHAT_V7).toContain('unpriced');
    expect(PROPERTY_CHAT_V7).toContain("don't list a price");
  });
});
