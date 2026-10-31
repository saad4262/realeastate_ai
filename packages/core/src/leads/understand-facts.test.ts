import { describe, expect, it } from 'vitest';
import { amountsIn, briefFrom, countsIn, rawUnderstandingSchema, verifyUnderstanding } from './understand-facts';

/** ADR 0078 / non-negotiable 4: a fact the enquiry does not say is dropped; a number is read by code, never made. */

const ENQUIRY = 'Hi, we’ve sold our place and need to buy within the next month. Looking for 3 or 4 bedrooms in Pakenham or Officer, a house with a yard, budget $750k to $820k. Can we see Lakeside this weekend?';
const raw = (facts: unknown[], extra: Record<string, unknown> = {}) =>
  rawUnderstandingSchema.parse({ intent: 'buyer', intent_why: 'They need to buy.', urgency: 'high', urgency_why: 'Already sold; buying within a month.', summary: 'Sold; wants a 3–4 bed house in Pakenham or Officer.', facts, ...extra });

describe('reading figures out of words', () => {
  it('amounts', () => {
    expect(amountsIn('$750k to $820k')).toEqual([750000, 820000]);
    expect(amountsIn('up to $1.2m')).toEqual([1200000]);
    expect(amountsIn('around $820,000')).toEqual([820000]);
    expect(amountsIn('750 thousand')).toEqual([750000]);
  });
  it('counts, in digits or words', () => {
    expect(countsIn('3 or 4 bedrooms')).toEqual([3, 4]);
    expect(countsIn('three bedrooms, two bathrooms')).toEqual([3, 2]);
  });
});

describe('keeps what the enquiry says', () => {
  it('a buyer brief, each figure read from its quote', () => {
    const u = verifyUnderstanding(raw([
      { field: 'price_from', value: 750000, quote: '$750k' },
      { field: 'price_to', value: 820000, quote: '$820k' },
      { field: 'bedrooms', value: 3, quote: '3 or 4 bedrooms' },
      { field: 'suburbs', value: ['Pakenham', 'Officer'], quote: 'Pakenham or Officer' },
      { field: 'property_type', value: 'house', quote: 'a house with a yard' },
      { field: 'timeline', value: 'within the next month', quote: 'within the next month' },
    ]), ENQUIRY);
    expect(u.facts.map((f) => [f.field, f.value])).toEqual([
      ['price_from', 750000], ['price_to', 820000], ['bedrooms', 3], ['suburbs', ['Pakenham', 'Officer']], ['property_type', 'house'], ['timeline', 'within the next month'],
    ]);
    expect(u.dropped).toEqual([]);
    expect(briefFrom(u)).toEqual({ channel: 'sale', priceMin: 750000, priceMax: 820000, minBedrooms: 3, suburbs: ['Pakenham', 'Officer'], propertyTypes: ['house'] });
  });
  it('curly quotes and spacing in the enquiry do not matter', () => {
    const u = verifyUnderstanding(raw([{ field: 'timeline', value: 'within the next month', quote: "we've sold our place and need to buy within  the next month" }]), ENQUIRY);
    expect(u.facts).toHaveLength(1);
  });
});

describe('drops what it does not', () => {
  it('a quote that is not in the enquiry', () => {
    const u = verifyUnderstanding(raw([{ field: 'bathrooms', value: 2, quote: '2 bathrooms' }]), ENQUIRY);
    expect(u.facts).toEqual([]);
    expect(u.dropped).toEqual([{ field: 'bathrooms', value: '2', why: 'not_in_enquiry' }]);
  });
  it('a figure its quote does not say — the model rounding, guessing or adding', () => {
    const u = verifyUnderstanding(raw([
      { field: 'price_to', value: 850000, quote: '$820k' },
      { field: 'bedrooms', value: 5, quote: '3 or 4 bedrooms' },
      { field: 'price_from', value: 750000, quote: 'Pakenham or Officer' },
    ]), ENQUIRY);
    expect(u.facts).toEqual([]);
    expect(u.dropped.map((d) => d.why)).toEqual(['not_in_quote', 'not_in_quote', 'not_in_quote']);
  });
  it('a suburb the quote does not name, and a type that is not ours', () => {
    const u = verifyUnderstanding(raw([
      { field: 'suburbs', value: ['Pakenham', 'Berwick'], quote: 'Pakenham or Officer' },
      { field: 'property_type', value: 'mansion', quote: 'a house with a yard' },
    ]), ENQUIRY);
    expect(u.facts).toEqual([{ field: 'suburbs', value: ['Pakenham'], quote: 'Pakenham or Officer' }]);
    expect(u.dropped).toEqual([{ field: 'suburbs', value: 'Berwick', why: 'not_in_quote' }, { field: 'property_type', value: 'mansion', why: 'not_a_known_value' }]);
  });
  it('a summary or a reason with a figure the enquiry does not have', () => {
    const u = verifyUnderstanding(raw([], { summary: 'Wants a house around $900k.', urgency_why: 'Needs to move in 2 weeks.' }), ENQUIRY);
    expect(u.summary).toBeNull();
    expect(u.urgencyWhy).toBeNull();
    expect(u.intentWhy).toBe('They need to buy.');
  });
  it('a malformed answer degrades to “not sure”, never throws', () => {
    const r = rawUnderstandingSchema.parse({ intent: 'alien', urgency: 'extreme', facts: 'lots' });
    expect(r).toMatchObject({ intent: 'not_sure', urgency: 'normal', facts: [] });
    expect(briefFrom(verifyUnderstanding(r, ENQUIRY))).toBeNull();
  });
  it('a tenant’s brief is for renting', () => {
    expect(briefFrom({ intent: 'tenant', facts: [{ field: 'bedrooms', value: 2, quote: '2 bedrooms' }] })).toEqual({ channel: 'rent', minBedrooms: 2 });
  });
});
