import { describe, expect, it } from 'vitest';
import { AU_DUTY_STATES } from '../affordability/duty-rates';
import { permitNotesFor, renovationRulesDue, STATE_PERMIT_RULES, STATE_SOURCE_DOMAINS } from './permits';
import { checkPlan, mentionsMoney, photoRoomsSchema, roomsFromPhotos } from './plan';
import { compareQuotes, formatCents, MIN_QUOTES, readDollarsToCents, type Quote } from './quotes';

describe('the plan the model returns (decisions 1 and 2)', () => {
  it('keeps known kinds once each, in its order; drops unknown kinds and any line with money', () => {
    const items = checkPlan({
      items: [
        { category: 'Kitchen', note: 'A new kitchen with an island bench.' },
        { category: 'granny_flat', note: 'A granny flat out the back.' },
        { category: 'kitchen', note: 'And a pantry.' },
        { category: 'deck', note: 'A bigger deck, about 5 × 4 m.' },
        { category: 'bathroom', note: 'A new bathroom, around $25k.' },
        { category: 'flooring', note: 'Hybrid floors at $60 per m2.' },
      ],
    });
    expect(items).toEqual([
      { category: 'kitchen', note: 'A new kitchen with an island bench.' },
      { category: 'deck', note: 'A bigger deck, about 5 × 4 m.' },
    ]);
  });

  it('reads money in every form, but not a size', () => {
    for (const s of ['$25,000', '25k', 'about 40 dollars', '120 AUD', '$60/m2', 'per square metre']) expect(mentionsMoney(s), s).toBe(true);
    for (const s of ['a 5 × 4 m deck', '3 bedrooms', 'built in 1975']) expect(mentionsMoney(s), s).toBe(false);
  });
});

describe('the photos (decision 3): rooms only', () => {
  it('refuses an answer that says anything about condition, whole', () => {
    expect(photoRoomsSchema.safeParse({ photos: [{ photo: 1, room: 'kitchen', condition: 'dated' }] }).success).toBe(false);
    expect(photoRoomsSchema.safeParse({ photos: [{ photo: 1, room: 'kitchen' }], notes: 'the bathroom looks old' }).success).toBe(false);
    expect(photoRoomsSchema.safeParse({ photos: [{ photo: 1, room: 'mouldy bathroom' }] }).success).toBe(false);
  });

  it('counts rooms in code, ignoring photos it was never sent and "other"', () => {
    const answer = photoRoomsSchema.parse({ photos: [{ photo: 1, room: 'kitchen' }, { photo: 2, room: 'bathroom' }, { photo: 3, room: 'bathroom' }, { photo: 3, room: 'bathroom' }, { photo: 4, room: 'other' }, { photo: 9, room: 'pool' }] });
    expect(roomsFromPhotos(answer, 6)).toEqual([
      { room: 'kitchen', photos: 1 },
      { room: 'bathroom', photos: 2 },
    ]);
  });
});

describe('permits (decision 5): only rules with an official state source', () => {
  it('every rule cites an https page on its own state’s government domain, with a date, once per trigger, and no dollar figure', () => {
    for (const st of AU_DUTY_STATES) {
      const seen = new Set<string>();
      for (const r of STATE_PERMIT_RULES[st].rules) {
        const url = new URL(r.source.url);
        expect(url.protocol, r.source.url).toBe('https:');
        const d = STATE_SOURCE_DOMAINS[st];
        expect(url.hostname === d.slice(1) || url.hostname.endsWith(d), `${st}: ${r.source.url}`).toBe(true);
        expect(r.source.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(r.note, r.note).not.toMatch(/\$|\baud\b|\bdollars?\b/i);
        expect(seen.has(r.trigger), `${st} ${r.trigger} twice`).toBe(false);
        seen.add(r.trigger);
      }
    }
  });

  it('every state has verified rules; every trigger we could not check from a STATE source says "not verified"', () => {
    expect(renovationRulesDue(new Date('2026-11-03T00:00:00Z')).unverifiedStates).toEqual([]);
    // WA's structural text found was councils', not the state's; its electrical rule is the state's.
    expect(permitNotesFor('WA', ['remove_wall']).map((n) => [n.trigger, n.verified])).toEqual([
      ['structural', false],
      ['electrical', true],
      ['heritage', false],
      ['strata', false],
      ['older_home_materials', false],
    ]);
    // TAS electrical: councils only. NT electrical, asbestos and pools: nothing found.
    expect(permitNotesFor('TAS', ['electrical_upgrade']).find((n) => n.trigger === 'electrical')?.verified).toBe(false);
    expect(permitNotesFor('NT', ['pool']).filter((n) => n.verified).map((n) => n.trigger)).toEqual(['plumbing']);
    const vic = permitNotesFor('VIC', ['kitchen', 'remove_wall']);
    expect(vic.map((n) => [n.trigger, n.verified])).toEqual([
      ['structural', true],
      ['wet_area', false],
      ['electrical', true],
      ['plumbing', true],
      ['gas', true],
      ['heritage', true],
      ['strata', false],
      ['older_home_materials', true],
    ]);
    // NSW's pool text found was a council's, not the state's: not verified.
    expect(permitNotesFor('NSW', ['pool']).find((n) => n.trigger === 'pool_or_spa')?.verified).toBe(false);
  });

  it('a verified note carries its source; a trigger the plan does not raise is not listed', () => {
    const notes = permitNotesFor('QLD', ['remove_wall']);
    expect(notes[0]).toMatchObject({ trigger: 'structural', verified: true, source: { name: 'QBCC — building approvals and certification' } });
    expect(notes.map((n) => n.trigger)).not.toContain('pool_or_spa');
  });

  it('every verified rule is due again after the next 1 July', () => {
    const due = renovationRulesDue(new Date('2027-07-02T00:00:00Z'));
    const count = AU_DUTY_STATES.reduce((n, st) => n + STATE_PERMIT_RULES[st].rules.length, 0);
    expect(due.stale).toHaveLength(count);
    expect(renovationRulesDue(new Date('2027-06-30T00:00:00Z')).stale).toEqual([]);
  });
});

describe('the buyer’s quotes (decision 4): arithmetic in code, in cents', () => {
  const q = (id: string, category: Quote['category'], dollars: number, trade = 'Builder'): Quote => ({ id, category, trade, amountCents: dollars * 100, includes: '' });

  it('reads amounts as people write them, to the cent, and refuses the rest', () => {
    expect(readDollarsToCents('$38,500')).toBe(3_850_000);
    expect(readDollarsToCents('38,500.5')).toBe(3_850_050);
    expect(readDollarsToCents(0.1 + 0.2)).toBe(30);
    for (const bad of ['38.5k', '-100', '0', 'abc', '$38,500.555', '20000000']) expect(readDollarsToCents(bad), bad).toBeNull();
  });

  it('the mock’s quotes: lowest per kind added up, the spread, and which work needs more quotes', () => {
    const c = compareQuotes([q('a', 'kitchen', 38_500), q('b', 'kitchen', 41_200), q('c', 'remove_wall', 14_800), q('d', 'deck', 16_900, 'Deck Co')]);
    expect(c.groups.map((g) => g.category)).toEqual(['kitchen', 'remove_wall', 'deck']);
    expect(c.groups[0]).toMatchObject({ spreadCents: 270_000, lowest: { id: 'a' }, highest: { id: 'b' }, needMoreQuotes: true });
    expect(formatCents(c.lowestTotalCents)).toBe('$70,200');
    expect(formatCents(c.highestTotalCents)).toBe('$72,900');
    expect(c.needMoreQuotes).toEqual(['kitchen', 'remove_wall', 'deck']);
  });

  it('three quotes is enough; ties are ordered by id, never by typing order', () => {
    const c = compareQuotes([q('z', 'deck', 10_000), q('m', 'deck', 10_000), q('a', 'deck', 12_000)]);
    expect(c.groups[0]!.quotes.map((x) => x.id)).toEqual(['m', 'z', 'a']);
    expect(c.groups[0]!.needMoreQuotes).toBe(false);
    expect(MIN_QUOTES).toBe(3);
  });

  it('no float drift: cents add exactly', () => {
    const c = compareQuotes([{ id: '1', category: 'painting', trade: 'P', amountCents: 10, includes: '' }, { id: '2', category: 'lighting', trade: 'E', amountCents: 20, includes: '' }]);
    expect(c.lowestTotalCents).toBe(30);
    expect(formatCents(c.lowestTotalCents)).toBe('$0.30');
  });

  it('refuses a duplicate id, an unknown kind or a negative amount', () => {
    expect(() => compareQuotes([q('a', 'deck', 1), q('a', 'deck', 2)])).toThrow(/own id/);
    expect(() => compareQuotes([{ ...q('a', 'deck', 1), category: 'granny_flat' as never }])).toThrow();
    expect(() => compareQuotes([{ ...q('a', 'deck', 1), amountCents: -5 }])).toThrow();
  });
});
