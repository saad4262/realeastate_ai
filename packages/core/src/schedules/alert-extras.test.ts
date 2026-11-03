import { describe, expect, it } from 'vitest';
import { buildScheduleDigestEmail, type ScheduleDigestInput } from '../email/schedule-digest';
import { alertExtras } from './alert-extras';

const base: ScheduleDigestInput = {
  to: { email: 'buyer@example.com' },
  from: { email: 'alerts@site.test', name: 'Site' },
  postalAddress: '1 Example St, Sydney NSW 2000',
  scheduleName: '3 bed Pakenham',
  description: 'Houses for sale in Pakenham',
  matched: 3,
  newCount: 1,
  listings: [],
  summary: 'A quieter week.',
  summarySource: 'model',
  resultsUrl: 'https://site.test/search?suburb=Pakenham',
  unsubscribeUrl: 'https://site.test/unsubscribe?t=x',
};

describe('Smart Alerts upgrade (ADR 0080, C4 decision 6)', () => {
  it('adds price changes on homes it sent and recent sales, escaped, in both parts', () => {
    const msg = buildScheduleDigestEmail({
      ...base,
      extras: {
        priceChanges: [{ address: '14 Station St, <Officer>', text: 'from $780,000 – $820,000 to $760,000 – $800,000', url: 'https://site.test/listing/l1' }],
        sold: [{ address: '5 Example Road', price: '$702,000' }, { address: '19 Sample Avenue', price: 'price not disclosed' }],
        suburb: 'Pakenham',
      },
    });
    expect(msg.html).toContain('Price changes on homes we sent you');
    expect(msg.html).toContain('14 Station St, &lt;Officer&gt;');
    expect(msg.html).toContain('Sold in Pakenham since your last email');
    expect(msg.html).toContain('19 Sample Avenue — price not disclosed');
    expect(msg.text).toContain('  5 Example Road — $702,000');
    expect(msg.text).toContain('https://site.test/listing/l1');
  });

  it('no section when there is nothing, and the model’s paragraph is left as it was written', () => {
    const plain = buildScheduleDigestEmail(base);
    const empty = buildScheduleDigestEmail({ ...base, extras: { priceChanges: [], sold: [], suburb: 'Pakenham' } });
    for (const msg of [plain, empty]) {
      expect(msg.html).not.toContain('Price changes on homes');
      expect(msg.html).not.toContain('since your last email');
    }
    expect(plain.html).toContain('A quieter week.');
  });

  it('a first run has no "since your last email": nothing is read', async () => {
    expect(await alertExtras({} as never, { query: { suburb: 'Pakenham', channel: 'sale' }, lastEmailedAt: null, sentListingIds: ['x'] })).toEqual({ priceChanges: [], sold: [], suburb: null });
  });
});
