import { describe, expect, it } from 'vitest';
import { areaText, opportunityAskFromProfile, opportunityQuery, parseOpportunityLink, signalsOfRow, type RawOpportunityRow } from './find';
import { BANNED_WORDS, emptyReason, judgementWords, SIGNAL_KINDS, SIGNAL_TEXT, signalLine, signalNote } from './signals';
import { opportunityToolResult } from './tool';

const raw = (over: Partial<RawOpportunityRow>): RawOpportunityRow => ({
  listing_id: 'l1',
  property_id: 'p1',
  street: '5 Bay Court',
  suburb: 'Officer',
  state: 'VIC',
  price_display: 'Offers over $695,000',
  price_from: '695000.00',
  price_to: null,
  bedrooms: 3,
  bathrooms: '1.0',
  property_type: 'house',
  published_at: '2026-10-20T00:00:00Z',
  days: 15,
  changed_at: null,
  old_display: null,
  old_from: null,
  old_to: null,
  new_display: null,
  new_from: null,
  new_to: null,
  lower_by: null,
  asking_from: '695000.00',
  median: null,
  sales: 0,
  ...over,
});

describe('Opportunity AI: three signals, each decided from SQL’s figures (decision 5)', () => {
  it('a price reduction is the low end going down, with Postgres’s difference', () => {
    const [s] = signalsOfRow(raw({ changed_at: '2026-11-18T03:00:00Z', old_display: 'Offers over $720,000', old_from: '720000.00', new_display: 'Offers over $695,000', new_from: '695000.00', lower_by: '25000.00' }));
    expect(s).toMatchObject({ kind: 'price_reduced', fromText: 'Offers over $720,000', toText: 'Offers over $695,000', lowerBy: 25_000 });
    expect(signalLine(s!)).toBe('On 18 Nov 2026, from Offers over $720,000 to Offers over $695,000: $25,000 lower.');
  });

  it('a rise, or "Contact agent" becoming a number, is no reduction', () => {
    expect(signalsOfRow(raw({ changed_at: '2026-11-18T03:00:00Z', lower_by: '-10000.00' }))).toEqual([]);
    expect(signalsOfRow(raw({ changed_at: '2026-11-18T03:00:00Z', lower_by: null }))).toEqual([]);
  });

  it('a long campaign is 60 days or more in this campaign', () => {
    expect(signalsOfRow(raw({ days: 59 }))).toEqual([]);
    const [s] = signalsOfRow(raw({ days: 94, published_at: '2026-08-02T00:00:00Z' }));
    expect(signalLine(s!)).toBe('94 days on the market in this campaign, since 2 Aug 2026.');
    expect(signalNote(s!, 42)).toBe('The median for homes for sale on this site today is 42 days.');
  });

  it('below the median only with 10 sales of the same suburb, kind and bedrooms, and only when the asking low end is under it', () => {
    expect(signalsOfRow(raw({ asking_from: '640000', median: 675000, sales: 9 }))).toEqual([]);
    expect(signalsOfRow(raw({ asking_from: '680000', median: 675000, sales: 12 }))).toEqual([]);
    expect(signalsOfRow(raw({ asking_from: '640000', median: 675000, sales: 12, bedrooms: null }))).toEqual([]);
    const [s] = signalsOfRow(raw({ suburb: 'Pakenham', asking_from: '640000', median: '675000.4', sales: 12 }));
    expect(signalLine(s!)).toBe('Asking from $640,000. 3-bedroom houses sold on this site in Pakenham, last 12 months: median $675,000 (12 sales).');
  });
});

describe('Opportunity AI: facts, never a verdict (decision 6)', () => {
  it('none of our words judges a home, its price or its seller', () => {
    for (const k of SIGNAL_KINDS) {
      const t = SIGNAL_TEXT[k];
      for (const text of [t.label, t.filter, t.meaning, ...t.questions, emptyReason(k, 'Pakenham', 4), emptyReason(k, 'Pakenham', 12)]) expect(judgementWords(text), text).toEqual([]);
    }
  });
  it('the ban catches the words it is for', () => {
    expect(judgementWords('A real bargain from a motivated vendor — great value, won’t last')).toEqual(['bargain', 'motivated', 'great value']);
    expect(judgementWords('This home is under-priced')).toEqual(['under-priced']);
    expect(BANNED_WORDS.length).toBeGreaterThan(8);
  });
  it('the guide’s result carries the same words and the rule', () => {
    const out = opportunityToolResult(
      { area: 'Officer', homes: [{ listingId: 'l1', propertyId: 'p1', address: '5 Bay Court, Officer', suburb: 'Officer', state: 'VIC', price: 'Offers over $695,000', bedrooms: 3, bathrooms: 1, propertyType: 'house', signals: signalsOfRow(raw({ days: 70 })) }], counts: { price_reduced: 0, long_campaign: 1, below_median: 0 }, emptyWhy: { price_reduced: 'none yet' }, medianDaysOnMarket: 42, truncated: false },
      { suburbs: ['officer'], state: null, priceTo: 800_000, bedrooms: null, propertyType: null, signals: [] },
    );
    expect(out.homes[0]!.signals[0]).toMatchObject({ kind: 'long_campaign', label: 'On the market a long time', askTheAgent: SIGNAL_TEXT.long_campaign.questions });
    expect(out.page).toBe('/opportunities?suburbs=Officer&max=800000');
    expect(out.notShown).toEqual(['none yet']);
    expect(out.rules).toMatch(/never call a home a bargain/);
  });
});

describe('Opportunity AI: says what it cannot show (decision 8)', () => {
  it('names the rule and the count', () => {
    expect(emptyReason('price_reduced', 'Berwick', 1)).toBe('Price changes are recorded from 3 Nov 2026. None in Berwick yet.');
    expect(emptyReason('below_median', 'Berwick', 1)).toBe('Needs 10 sales of homes of the same kind and bedrooms in one suburb in 12 months. The most on this site in Berwick: 1.');
  });
});

describe('Opportunity AI: the link and "Match my profile" (decision 7)', () => {
  it('reads an area, a ceiling, bedrooms, a kind and signals; nothing without an area', () => {
    expect(parseOpportunityLink({})).toBeNull();
    expect(parseOpportunityLink({ max: '800000' })).toBeNull();
    const ask = parseOpportunityLink({ suburbs: 'Pakenham, Officer,  ;drop table', state: 'vic', max: '800000', beds: '3', type: 'House', signals: 'price_reduced,nonsense' });
    expect(ask).toEqual({ suburbs: ['pakenham', 'officer'], state: 'VIC', priceTo: 800_000, bedrooms: 3, propertyType: 'house', signals: ['price_reduced'] });
    expect(opportunityQuery(ask!)).toBe('suburbs=Pakenham%2C+Officer&state=VIC&max=800000&beds=3&type=house&signals=price_reduced');
    expect(areaText(ask!)).toBe('Pakenham, Officer VIC');
    expect(parseOpportunityLink({ state: 'VIC', s: ['long_campaign', 'below_median', 'x'] })?.signals).toEqual(['long_campaign', 'below_median']);
  });
  it('fills from the profile, and not for a renter', () => {
    const facts = { suburbs: { value: ['Pakenham'], by: 'learnt' as const, sources: [] }, channel: null, priceTo: { value: 800_000, by: 'you' as const, sources: [] }, bedrooms: { value: 3, by: 'learnt' as const, sources: [] }, propertyTypes: { value: ['House'], by: 'learnt' as const, sources: [] } };
    expect(opportunityAskFromProfile(facts)).toEqual({ suburbs: ['pakenham'], state: null, priceTo: 800_000, bedrooms: 3, propertyType: 'house', signals: [] });
    expect(opportunityAskFromProfile({ ...facts, channel: { value: 'rent', by: 'learnt', sources: [] } })).toBeNull();
  });
});
