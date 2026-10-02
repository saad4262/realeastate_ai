import { describe, expect, it } from 'vitest';
import type { DbOrTx } from '@repo/db';
import { createEnquiry, EnquiryError } from './create-enquiry';
import { enquiryInputSchema } from './lead-schema';

/**
 * A builder that records what was inserted.
 *
 * This endpoint has no actor to ask can() about — it is a public, anonymous
 * form — so its authorisation story is entirely "what does the server decide
 * rather than accept". These tests are that story.
 */
function fakeDb(listingRows: unknown[]) {
  const inserted: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {};

  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(listingRows);
  chain.insert = () => chain;
  chain.values = (v: Record<string, unknown>) => {
    inserted.push(v);
    return chain;
  };
  chain.returning = () => Promise.resolve([{ id: 'lead-1' }]);

  return { db: chain as unknown as DbOrTx, inserted };
}

const VALID = {
  name: 'Jane Buyer',
  email: 'jane@example.test',
  phone: '0412 884 920',
  message: 'I would like to arrange an inspection this weekend.',
};

/**
 * What the listing lookup answers with. The propertyId matters: a lead is
 * anchored to the address, and an empty-row fake would let the column be
 * silently undefined while every assertion still passed.
 */
const LIVE = [{ agencyId: 'agency-real', propertyId: 'property-real' }];

describe('a public enquiry', () => {
  it('records the enquiry against the listing', async () => {
    const { db, inserted } = fakeDb(LIVE);
    const { leadId } = await createEnquiry(db, 'listing-1', VALID);

    expect(leadId).toBe('lead-1');
    expect(inserted[0]).toMatchObject({
      // Both keys, and the property one comes from the listing rather than the
      // caller — an enquiry and a private offer on the same address have to
      // land in the same inbox for that inbox to mean anything.
      propertyId: 'property-real',
      listingId: 'listing-1',
      name: 'Jane Buyer',
      email: 'jane@example.test',
      kind: 'enquiry',
      status: 'new',
    });
  });

  /**
   * The one that matters.
   *
   * The browser picks which listing it is writing to and nothing else. An
   * agencyId accepted from the caller would let anyone file a lead into any
   * agency's inbox.
   */
  it('takes the agency from the listing, never from the caller', async () => {
    const { db, inserted } = fakeDb(LIVE);
    await createEnquiry(db, 'listing-1', {
      ...VALID,
      agencyId: 'agency-attacker',
      listingId: 'somewhere-else',
    });

    expect(inserted[0]?.agencyId).toBe('agency-real');
    expect(inserted[0]?.listingId).toBe('listing-1');
  });

  it('writes nothing when the listing lookup comes back empty', async () => {
    /**
     * What this does and does not prove.
     *
     * It proves the refusal PATH: no row found, no insert, an EnquiryError.
     * It does NOT prove the query filters on status — this fake ignores the
     * WHERE clause entirely, and dropping `eq(listing.status, 'live')` from
     * the real query leaves this test green. Checked, by doing exactly that.
     *
     * The status filter is asserted against real SQL in `pnpm smoke`
     * ("an enquiry cannot be filed against a listing that is not live"),
     * which is the only place it can be.
     */
    const { db, inserted } = fakeDb([]);
    await expect(createEnquiry(db, 'a-draft', VALID)).rejects.toThrow(EnquiryError);
    expect(inserted).toHaveLength(0);
  });

  it('never lets the caller choose status, kind or assignment', async () => {
    const { db, inserted } = fakeDb(LIVE);
    await createEnquiry(db, 'listing-1', {
      ...VALID,
      status: 'closed',
      kind: 'appraisal',
      assignedTo: 'someone',
      aiSummary: 'injected',
    });

    expect(inserted[0]?.status).toBe('new');
    expect(inserted[0]?.kind).toBe('enquiry');
    expect(inserted[0]).not.toHaveProperty('assignedTo');
    expect(inserted[0]).not.toHaveProperty('aiSummary');
  });

  it('writes nothing when the input is invalid', async () => {
    const { db, inserted } = fakeDb(LIVE);
    await expect(createEnquiry(db, 'listing-1', { ...VALID, email: 'nope' })).rejects.toThrow(
      /email/i,
    );
    expect(inserted).toHaveLength(0);
  });
});

describe('the enquiry contract', () => {
  it.each([
    ['a missing name', { ...VALID, name: '' }],
    ['a one-letter name', { ...VALID, name: 'J' }],
    ['a bad email', { ...VALID, email: 'jane@' }],
    ['an empty message', { ...VALID, message: '' }],
    ['a message of two characters', { ...VALID, message: 'hi' }],
  ])('refuses %s', (_label, input) => {
    expect(enquiryInputSchema.safeParse(input).success).toBe(false);
  });

  it('accepts an Australian phone in any of the ways people write one', () => {
    // A regex here refuses real numbers buyers typed correctly, which costs an
    // agency a lead. Length is the only thing worth enforcing.
    for (const phone of ['0412 884 920', '+61 412 884 920', '(03) 5941 1234', '03-5941-1234']) {
      expect(enquiryInputSchema.safeParse({ ...VALID, phone }).success).toBe(true);
    }
  });

  it('treats the phone as optional', () => {
    const { phone: _drop, ...noPhone } = VALID;
    expect(enquiryInputSchema.safeParse(noPhone).success).toBe(true);
  });
});
