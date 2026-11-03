import { describe, expect, it } from 'vitest';
import { PERMIT_TRIGGERS, RENOVATION_CATEGORIES, RENOVATION_CATEGORY_KEYS, RENOVATION_GROUPS, TRADE_LABELS, TRADES, isRenovationCategoryKey } from './categories';

describe('the fixed kinds of work (ADR 0080, C3 decision 2)', () => {
  it('25 kinds, each once, in catalog order, each in a known group', () => {
    expect(RENOVATION_CATEGORIES).toHaveLength(25);
    expect(RENOVATION_CATEGORIES.map((c) => c.key)).toEqual([...RENOVATION_CATEGORY_KEYS]);
    expect(new Set(RENOVATION_CATEGORY_KEYS).size).toBe(25);
    for (const c of RENOVATION_CATEGORIES) expect(RENOVATION_GROUPS).toContain(c.group);
  });

  it('every kind has cost drivers, known trades and known triggers', () => {
    for (const c of RENOVATION_CATEGORIES) {
      expect(c.costDrivers.length, c.key).toBeGreaterThan(0);
      expect(c.trades.length, c.key).toBeGreaterThan(0);
      for (const tr of c.trades) expect(TRADES).toContain(tr);
      for (const tg of c.triggers) expect(PERMIT_TRIGGERS).toContain(tg);
    }
    for (const tr of TRADES) expect(TRADE_LABELS[tr]).toBeTruthy();
  });

  /** Decision 1, the product team's rule "no estimated costs": not a dollar, not a rate, not a number at all. */
  it('carries no price, no rate and no number anywhere in its words', () => {
    for (const c of RENOVATION_CATEGORIES) {
      for (const text of [c.name, c.description, ...c.costDrivers]) {
        expect(text, `${c.key}: ${text}`).not.toMatch(/\$|\d|\baud\b|\bdollars?\b|per\s?m|cost(s)? (about|around|from)/i);
      }
    }
  });

  it('knows only its own keys', () => {
    expect(isRenovationCategoryKey('kitchen')).toBe(true);
    expect(isRenovationCategoryKey('Kitchen')).toBe(false);
    expect(isRenovationCategoryKey('granny_flat')).toBe(false);
  });
});
