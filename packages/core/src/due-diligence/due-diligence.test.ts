import { describe, expect, it } from 'vitest';
import { AU_DUTY_STATES } from '../affordability/duty-rates';
import { checklistFor, dueDiligenceDue, GENERAL_CHECKLIST, STATE_CHECKLISTS } from './checklists';
import { recordFacts } from './records';

describe('the state checklists (ADR 0080, C2)', () => {
  it('every verified state names its official source and the day it was checked; the rest say they are not verified', () => {
    for (const s of AU_DUTY_STATES) {
      const c = STATE_CHECKLISTS[s];
      if (c.items) {
        expect(c.source?.url).toMatch(/^https:\/\/www\.(consumer\.vic|fairtrading\.nsw|qld|consumerprotection\.wa)\.gov\.au\//);
        expect(c.source?.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(c.items.length).toBeGreaterThan(0);
      } else {
        expect(c.source).toBeNull();
      }
    }
    expect(dueDiligenceDue(new Date('2026-11-03T00:00:00Z')).unverified.sort()).toEqual(['ACT', 'NT', 'SA', 'TAS']);
  });

  it('item ids are unique across every list, so a tick in the browser never lands on another item', () => {
    const ids = [...GENERAL_CHECKLIST, ...Object.values(STATE_CHECKLISTS).flatMap((c) => c.items ?? [])].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is due again after the next 1 July', () => {
    expect(dueDiligenceDue(new Date('2027-06-30T00:00:00Z')).stale).toEqual([]);
    expect(dueDiligenceDue(new Date('2027-07-01T00:00:00Z')).stale.map((s) => s.state).sort()).toEqual(['NSW', 'QLD', 'VIC', 'WA']);
  });

  it('knows only the eight states', () => {
    expect(checklistFor('QLD')?.items?.[0]?.id).toBe('qld-form2');
    expect(checklistFor('XYZ')).toBeNull();
  });
});

describe('what our records show', () => {
  const sold = (id: string, date: string, price: number | null) => ({ listingId: id, channel: 'sale' as const, status: 'sold' as const, priceDisplay: null, soldPrice: price, soldDate: new Date(date), publishedAt: new Date(date), agencyName: 'Alpha', mainPhotoKey: null, photoCount: 0 });

  it('the current listing first, its price changes, then the address’s history, each with its reference', () => {
    const facts = recordFacts({
      timeline: [
        { ...sold('now', '2026-09-23T01:00:00Z', null), status: 'live', soldDate: null },
        sold('a', '2019-03-14T01:00:00Z', 455_000),
        sold('b', '2016-05-01T01:00:00Z', null),
      ],
      current: { id: 'now', channel: 'sale', publishedAt: new Date('2026-09-23T01:00:00Z'), daysOnMarket: 41, priceDisplay: 'Offers over $720,000', priceFrom: '720000', priceTo: null },
      priceChanges: [{ changedAt: new Date('2026-10-20T01:00:00Z'), oldDisplay: 'Offers over $750,000', oldFrom: '750000', oldTo: null, newDisplay: 'Offers over $720,000', newFrom: '720000', newTo: null }],
    });
    expect(facts).toEqual([
      { ref: 'R1', when: 'Now', text: 'For sale since 23 Sept 2026 — 41 days on the market. Offers over $720,000.' },
      { ref: 'R2', when: '20 Oct 2026', text: 'Price changed from Offers over $750,000 to Offers over $720,000.' },
      { ref: 'R3', when: '14 Mar 2019', text: 'Sold for $455,000.' },
      { ref: 'R4', when: '1 May 2016', text: 'Sold — price not disclosed.' },
    ]);
  });

  it('says there are no price changes only since recording began, and never invents a days count', () => {
    const facts = recordFacts({ timeline: [], current: { id: 'x', channel: 'sale', publishedAt: new Date('2026-11-01T01:00:00Z'), daysOnMarket: null, priceDisplay: null, priceFrom: '600000', priceTo: '650000' }, priceChanges: [] });
    expect(facts[0]!.text).toBe('For sale since 1 Nov 2026. $600,000 – $650,000.');
    expect(facts[1]!.text).toMatch(/^None since we began recording on 3 Nov 2026\.$/);
  });

  it('an address not for sale: its history only', () => {
    const facts = recordFacts({ timeline: [sold('a', '2021-06-02T01:00:00Z', 1_120_000)], current: null, priceChanges: [] });
    expect(facts).toEqual([{ ref: 'R1', when: '2 June 2021', text: 'Sold for $1,120,000.' }]);
  });
});
