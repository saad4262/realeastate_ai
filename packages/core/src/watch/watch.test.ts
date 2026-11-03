import { describe, expect, it } from 'vitest';
import { signWatchUnsubscribeToken, verifyContactUnsubscribeToken, verifyUnsubscribeToken, verifyWatchUnsubscribeToken } from '../email';
import { standingOf, watchEvents, type CurrentCampaign } from './detect';
import { buildWatchDigest, localClock } from './tick';
import { safeTimeZone, unwatchProperty, watchProperty, WatchError, listWatches } from './watch';

const camp = (over: Partial<CurrentCampaign> = {}): CurrentCampaign => ({ listingId: 'L1', status: 'live', channel: 'sale', isPublic: true, price: '$1,150,000 – $1,250,000', soldPrice: null, ...over });

describe('what changed at a watched address (ADR 0080, C4 decision 2)', () => {
  it('Not for Sale → For Sale: a campaign the buyer has not seen', () => {
    expect(watchEvents({ listingId: null, status: 'none' }, camp())).toEqual([{ kind: 'listed', text: 'Listed for sale — $1,150,000 – $1,250,000.', listingId: 'L1' }]);
    expect(watchEvents({ listingId: null, status: 'none' }, camp({ channel: 'rent', price: '$650 per week' }))[0]!.text).toBe('Listed for rent — $650 per week.');
  });

  it('the same campaign moving on: under offer, sold (with or without a price), back on the market', () => {
    expect(watchEvents({ listingId: 'L1', status: 'for_sale' }, camp({ status: 'under_offer', isPublic: false }))).toEqual([{ kind: 'under_offer', text: 'Under offer.', listingId: 'L1' }]);
    expect(watchEvents({ listingId: 'L1', status: 'under_offer' }, camp({ status: 'sold', isPublic: false, soldPrice: 1_200_000 }))[0]!.text).toBe('Sold for $1,200,000.');
    expect(watchEvents({ listingId: 'L1', status: 'for_sale' }, camp({ status: 'sold', isPublic: false }))[0]!.text).toBe('Sold — price not disclosed.');
    expect(watchEvents({ listingId: 'L1', status: 'under_offer' }, camp())[0]).toMatchObject({ kind: 'back_on_market', text: 'Back on the market — $1,150,000 – $1,250,000.' });
  });

  it('a withdrawn campaign is "no longer advertised" — never "withdrawn" (decision 3)', () => {
    const [e] = watchEvents({ listingId: 'L1', status: 'for_sale' }, camp({ status: 'withdrawn', isPublic: false }));
    expect(e).toMatchObject({ kind: 'not_advertised', text: 'No longer advertised on this site.' });
    expect(JSON.stringify(e)).not.toMatch(/withdr/i);
  });

  it('nothing to say: no change, no campaign, or a campaign never advertised while watched', () => {
    expect(watchEvents({ listingId: 'L1', status: 'for_sale' }, camp())).toEqual([]);
    expect(watchEvents({ listingId: null, status: 'none' }, null)).toEqual([]);
    expect(watchEvents({ listingId: 'L0', status: 'sold' }, camp({ listingId: 'L2', status: 'withdrawn', isPublic: false }))).toEqual([]);
    expect(standingOf(null)).toBe('none');
  });
});

describe('the daily email (decision 4)', () => {
  it('8 am is read in the buyer’s own zone', () => {
    const t = new Date('2026-11-03T21:30:00Z');
    expect(localClock(t, 'Australia/Sydney')).toEqual({ hour: 8, date: '2026-11-04' });
    expect(localClock(t, 'Australia/Perth').hour).toBe(5);
    expect(safeTimeZone('Australia/Perth')).toBe('Australia/Perth');
    expect(safeTimeZone('Mars/Olympus')).toBe('Australia/Sydney');
    expect(safeTimeZone(42)).toBe('Australia/Sydney');
  });

  it('one message, every change, escaped, with the sender, the Watching link and an unsubscribe that turns Property Monitor off', () => {
    const msg = buildWatchDigest({
      to: 'buyer@example.com',
      sender: { from: { email: 'alerts@site.test', name: 'Site' }, postalAddress: '1 Example St, Sydney NSW 2000' },
      baseUrl: 'https://site.test/',
      unsubscribeUrl: 'https://site.test/unsubscribe?t=w.x.y',
      groups: [{ address: '22 Sample <St>, Brunswick VIC', link: 'https://site.test/property/p1', lines: [{ text: 'Listed for sale — $1,150,000.', on: '2 Nov 2026' }, { text: 'Under offer.', on: '3 Nov 2026' }] }],
    });
    expect(msg.kind).toBe('marketing');
    expect(msg.subject).toBe('2 changes on addresses you watch');
    expect(msg.listUnsubscribeUrl).toBe('https://site.test/unsubscribe?t=w.x.y');
    expect(msg.html).toContain('22 Sample &lt;St&gt;');
    expect(msg.html).toContain('https://site.test/account/watching');
    expect(msg.text).toContain('1 Example St, Sydney NSW 2000');
    expect(() => buildWatchDigest({ to: 'a', sender: { from: { email: 'a', name: '' }, postalAddress: '' }, baseUrl: 'x', unsubscribeUrl: 'y', groups: [] })).toThrow();
  });

  it('its unsubscribe token is its own kind: never read as a saved search’s or a contact’s', () => {
    const id = '6f1f7a2e-3c1b-4f7e-9a51-1d2e3f4a5b6c';
    const token = signWatchUnsubscribeToken(id, 'secret');
    expect(verifyWatchUnsubscribeToken(token, 'secret')).toEqual({ ok: true, userId: id });
    expect(verifyWatchUnsubscribeToken(token, 'other')).toEqual({ ok: false });
    expect(verifyUnsubscribeToken(token, 'secret').ok).toBe(false);
    expect(verifyContactUnsubscribeToken(token, 'secret').ok).toBe(false);
  });
});

describe('who may watch', () => {
  it('a signed-out actor is refused before anything is read', async () => {
    for (const call of [() => watchProperty({} as never, { userId: '' }, { listingId: 'x' }), () => unwatchProperty({} as never, { userId: '' }, 'p'), () => listWatches({} as never, { userId: '' })]) {
      await expect(call()).rejects.toBeInstanceOf(WatchError);
    }
  });
});
