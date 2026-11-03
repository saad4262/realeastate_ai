import { describe, expect, it } from 'vitest';
import { assistRecords, checkDraft, cleanLine, dueDiligenceAssist, DueDiligenceError } from './assist';

/** ADR 0080, C2: core decides what the model sees and keeps only lines that cite real records with their figures (#4). */
const facts = [
  { ref: 'R1', when: 'Now', text: 'For sale since 23 Sept 2026 — 41 days on the market. Offers over $720,000.' },
  { ref: 'R2', when: '14 Mar 2019', text: 'Sold for $455,000.' },
];

describe('what the model is given', () => {
  it('the facts, then the state checklist and the general list, each with its own reference', () => {
    const recs = assistRecords(facts, 'QLD');
    expect(recs[0]).toEqual({ ref: 'R1', text: 'Now: For sale since 23 Sept 2026 — 41 days on the market. Offers over $720,000.' });
    expect(recs[2]!.ref).toBe('K1');
    expect(recs[2]!.text).toMatch(/seller disclosure statement \(Form 2\)/);
    expect(recs.filter((r) => r.ref.startsWith('K')).length).toBeGreaterThan(6);
  });
});

describe('checking what comes back', () => {
  const recs = assistRecords(facts, 'QLD');

  it('keeps a cited line whose figures are in what it cites', () => {
    expect(checkDraft([{ text: 'It last sold for $455,000 in March 2019.', refs: ['R2'] }], recs, { max: 4, needFact: true })).toEqual([{ text: 'It last sold for $455,000 in March 2019.', refs: ['R2'] }]);
  });

  it('drops a figure the records do not hold, a reference that does not exist, a link, and a summary point citing only the checklist', () => {
    const lines = [
      { text: 'It is worth about $800,000.', refs: ['R1'] },
      { text: 'It sold before.', refs: ['R9'] },
      { text: 'See https://example.com for the history.', refs: ['R2'] },
      { text: 'Ask for the disclosure statement.', refs: ['K1'] },
    ];
    expect(checkDraft(lines, recs, { max: 4, needFact: true })).toEqual([]);
    // A question may rest on the checklist alone.
    expect(checkDraft(lines.slice(3), recs, { max: 4, needFact: false })).toHaveLength(1);
  });

  it('a figure stated in a record the line does not cite is still refused', () => {
    expect(checkDraft([{ text: 'It sold for $455,000.', refs: ['R1'] }], recs, { max: 4, needFact: true })).toEqual([]);
  });

  it('takes references written into the text out before checking, so "[K2]" is not read as the figure 2 (found live)', () => {
    expect(cleanLine('What zoning applies, and are there overlays? [K2]')).toBe('What zoning applies, and are there overlays?');
    expect(cleanLine('It last sold in March 2019 (R2, R3).')).toBe('It last sold in March 2019.');
    expect(cleanLine('Is the section 32 ready?')).toBe('Is the section 32 ready?');
    expect(checkDraft([{ text: 'Are you willing for me to arrange a building and pest inspection? [K4]', refs: ['K4'] }], recs, { max: 6, needFact: false })).toEqual([{ text: 'Are you willing for me to arrange a building and pest inspection?', refs: ['K4'] }]);
  });

  it('stops at the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ text: `Question ${String.fromCharCode(65 + i)}?`, refs: ['K1'] }));
    expect(checkDraft(many, recs, { max: 6, needFact: false })).toHaveLength(6);
  });
});

describe('without a model', () => {
  it('says the AI is unavailable before reading anything', async () => {
    await expect(dueDiligenceAssist({} as never, null, { listingId: 'x' })).rejects.toBeInstanceOf(DueDiligenceError);
  });
});
