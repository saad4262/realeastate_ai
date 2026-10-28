import { describe, expect, it } from 'vitest';
import { emailBatchStatusEnum, emailRecipientStatusEnum, emailTemplateStatusEnum } from '@repo/db/schema';
import { listingFieldsUsed, renderMerge, templateInputSchema, unknownMergeFields, BATCH_STATUS_LABELS, TEMPLATE_STATUS_LABELS } from './schema';
import { listingPriceWords } from './listing-values';

const values = { first_name: 'Tom', full_name: 'Tom Smith', agent_name: 'Sara', agency_name: 'Alpha' };

describe('merge fields', () => {
  it('fills the four it knows, from SQL values', () => {
    expect(renderMerge('Hi {{first_name}}, from {{ agent_name }} at {{agency_name}}', values)).toBe('Hi Tom, from Sara at Alpha');
  });
  it('refuses a template with a field that does not exist or a stray brace', () => {
    expect(unknownMergeFields('Hi {{suburb}}')).toEqual(['suburb']);
    expect(unknownMergeFields('Hi {{first_name}')).toEqual(['an unclosed {{ or }}']);
    expect(templateInputSchema.safeParse({ name: 'X1', subject: 'Hi {{nmae}}', body: 'b' }).success).toBe(false);
    expect(templateInputSchema.safeParse({ name: 'X1', subject: 'Hi {{first_name}}', body: 'Body' }).success).toBe(true);
  });
  it('matches the database vocabularies', () => {
    expect(Object.keys(TEMPLATE_STATUS_LABELS)).toEqual([...emailTemplateStatusEnum.enumValues]);
    expect(Object.keys(BATCH_STATUS_LABELS)).toEqual([...emailBatchStatusEnum.enumValues]);
    expect(emailRecipientStatusEnum.enumValues).toContain('sending');
  });
});

/** ADR 0060: three listing fields, filled only from a listing's values frozen at Prepare. */
describe('listing merge fields', () => {
  it('are known fields a template may use', () => {
    expect(unknownMergeFields('{{listing_address}} for {{listing_price}} — {{listing_link}}')).toEqual([]);
    expect(listingFieldsUsed('Hi {{first_name}}', 'See {{ listing_link }} and {{listing_address}}')).toEqual(['listing_address', 'listing_link']);
    expect(listingFieldsUsed('Hi {{first_name}}')).toEqual([]);
  });
  it('fill from the listing values, and stay as written without them (prepare refuses such a template first)', () => {
    const base = { first_name: 'Priya', full_name: 'Priya N', agent_name: 'Sarah', agency_name: 'Harbour' };
    expect(renderMerge('{{listing_address}} · {{first_name}}', { ...base, listing_address: '27 Lakeside Blvd' })).toBe('27 Lakeside Blvd · Priya');
    expect(renderMerge('{{listing_price}}', base)).toBe('{{listing_price}}');
  });
});

describe('listing price words', () => {
  it('says it as the public site does', () => {
    expect(listingPriceWords({ channel: 'sale', priceDisplay: null, priceFrom: 750000, priceTo: 790000, rentPw: null })).toBe('$750,000 – $790,000');
    expect(listingPriceWords({ channel: 'sale', priceDisplay: 'Auction 14 Nov', priceFrom: 750000, priceTo: null, rentPw: null })).toBe('Auction 14 Nov');
    expect(listingPriceWords({ channel: 'rent', priceDisplay: null, priceFrom: null, priceTo: null, rentPw: 650 })).toBe('$650 per week');
    expect(listingPriceWords({ channel: 'sale', priceDisplay: null, priceFrom: null, priceTo: null, rentPw: null })).toBe('Contact agent');
  });
});
