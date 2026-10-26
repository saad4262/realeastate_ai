import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import {
  createBuyerRequirement,
  deleteBuyerRequirement,
  setBuyerRequirementStatus,
  updateBuyerRequirement,
} from './buyer-requirements';
import { buyerRequirementSchema, describeRequirement, MAX_REQUIREMENTS_PER_CONTACT } from './contact-schema';

/**
 * Buyer requirements (ADR 0055): the contract the form and the server share, and who may write one.
 * No action of its own — `contact:update` decides — so the permission tests below are that rule,
 * asked through every write.
 */

const agencyA = '11111111-1111-1111-1111-111111111111';
const contactId = '33333333-3333-3333-3333-333333333333';
const reqId = '44444444-4444-4444-4444-444444444444';

const owner: Actor = { userId: 'u-owner', agencyId: agencyA, membershipRole: 'owner' };
const agent: Actor = { userId: 'u-agent', agencyId: agencyA, membershipRole: 'agent' };
const other: Actor = { userId: 'u-other', agencyId: agencyA, membershipRole: 'agent' };
const readOnly: Actor = { userId: 'u-ro', agencyId: agencyA, membershipRole: 'read_only' };

/** The contact as loadContactHead reads it: assigned to `agent`; `other` sees it through a lead of theirs. */
const head = (over: Record<string, unknown> = {}) => ({
  id: contactId,
  agencyId: agencyA,
  name: 'Priya',
  assignedTo: 'u-agent',
  mergedIntoId: null,
  leadAssigneeIds: ['u-other'],
  listingAgentIds: null,
  ...over,
});

const brief = { channel: 'sale' as const, priceMin: '800,000', priceMax: '$1,200,000', minBedrooms: '3', suburbs: ['bondi  beach', 'Coogee'], propertyTypes: ['House'] };

/** Chainable drizzle stand-in; every terminal hands back the next queued result. */
function fakeDb(results: unknown[][] = []) {
  let i = 0;
  const touched: string[] = [];
  const values: unknown[] = [];
  const sets: unknown[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'leftJoin', 'innerJoin', 'where', 'orderBy', 'update', 'set', 'insert', 'values', 'delete']) {
    chain[m] = (arg: unknown) => {
      touched.push(m);
      if (m === 'values') values.push(arg);
      if (m === 'set') sets.push(arg);
      return chain;
    };
  }
  chain.transaction = (fn: (tx: unknown) => unknown) => Promise.resolve(fn(chain));
  const next = () => Promise.resolve(results[i++] ?? []);
  chain.limit = next;
  chain.returning = next;
  chain.for = () => {
    touched.push('for');
    return next();
  };
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => next().then(res, rej);
  return { db: chain as unknown as Db, touched, values, sets };
}

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

describe('a brief, as the form sends it', () => {
  it('reads the figures an agent types, and turns blanks into "any"', () => {
    const v = buyerRequirementSchema.parse({ ...brief, maxBathrooms: undefined, minBathrooms: '' });
    expect(v).toMatchObject({ priceMin: 800_000, priceMax: 1_200_000, minBedrooms: 3, channel: 'sale', status: 'active' });
    expect(v.minBathrooms).toBeUndefined();
  });

  it('never guesses a shorthand figure', () => {
    expect(buyerRequirementSchema.safeParse({ priceMax: '1.2m' }).success).toBe(false);
    expect(buyerRequirementSchema.safeParse({ priceMax: '850k' }).success).toBe(false);
  });

  it('refuses a lowest price above the highest', () => {
    const r = buyerRequirementSchema.safeParse({ priceMin: 900_000, priceMax: 800_000 });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/above the highest/);
  });

  it('refuses a brief that says nothing — it would match every listing', () => {
    expect(buyerRequirementSchema.safeParse({ channel: 'sale', note: 'Nice area' }).success).toBe(false);
    expect(buyerRequirementSchema.safeParse({ suburbs: ['Bondi'] }).success).toBe(true);
  });

  it('writes one spelling per suburb and drops repeats, whatever the case', () => {
    const v = buyerRequirementSchema.parse({ suburbs: ['bondi  beach', 'BONDI BEACH', "o'connor", 'Coogee'] });
    expect(v.suburbs).toEqual(['Bondi Beach', "O'Connor", 'Coogee']);
  });

  it('takes property types from the list only, stored lower case', () => {
    expect(buyerRequirementSchema.parse({ propertyTypes: ['House', 'house', 'Townhouse'] }).propertyTypes).toEqual(['house', 'townhouse']);
    expect(buyerRequirementSchema.safeParse({ propertyTypes: ['castle'] }).success).toBe(false);
  });

  it('bedrooms are whole, bathrooms go in halves', () => {
    expect(buyerRequirementSchema.safeParse({ minBedrooms: 2.5 }).success).toBe(false);
    expect(buyerRequirementSchema.safeParse({ minBathrooms: 1.5 }).success).toBe(true);
    expect(buyerRequirementSchema.safeParse({ minBathrooms: 1.3 }).success).toBe(false);
  });
});

describe('describeRequirement', () => {
  it('says a brief in one line, from the stored figures', () => {
    expect(
      describeRequirement({
        channel: 'sale', priceMin: 800_000, priceMax: 1_200_000, minBedrooms: 3, minBathrooms: 2,
        suburbs: ['Bondi Beach', 'Coogee'], propertyTypes: ['house', 'townhouse'],
      }),
    ).toBe('Buying · $800,000 – $1,200,000 · 3+ bed · 2+ bath · House, Townhouse · Bondi Beach, Coogee');
  });

  it('says a weekly rent per week, and "any suburb" when none was given', () => {
    expect(
      describeRequirement({ channel: 'rent', priceMin: null, priceMax: 650, minBedrooms: null, minBathrooms: null, suburbs: [], propertyTypes: [] }),
    ).toBe('Renting · up to $650/wk · any suburb');
  });
});

describe('writing a brief (contact:update)', () => {
  it('the assigned agent adds one: typed columns, and a timeline line with the summary', async () => {
    const { db, values } = fakeDb([[head()], [{ id: contactId }], [{ n: 0 }], [{ id: reqId }], []]);
    await expect(createBuyerRequirement(db, agent, contactId, brief)).resolves.toEqual({ id: reqId });
    expect(values[0]).toMatchObject({
      agencyId: agencyA,
      contactId,
      createdBy: 'u-agent',
      channel: 'sale',
      // numeric columns take strings: precision is never lost.
      priceMin: '800000.00',
      priceMax: '1200000.00',
      minBedrooms: 3,
      minBathrooms: null,
      suburbs: ['Bondi Beach', 'Coogee'],
      propertyTypes: ['house'],
      status: 'active',
    });
    expect(values[1]).toMatchObject({
      kind: 'requirement_added',
      payload: { requirementId: reqId, summary: 'Buying · $800,000 – $1,200,000 · 3+ bed · House · Bondi Beach, Coogee' },
    });
  });

  it('locks the contact before counting, so two tabs cannot both pass the cap', async () => {
    const { db, touched } = fakeDb([[head()], [{ id: contactId }], [{ n: 0 }], [{ id: reqId }], []]);
    await createBuyerRequirement(db, agent, contactId, brief);
    expect(touched.indexOf('for')).toBeGreaterThan(-1);
    expect(touched.indexOf('for')).toBeLessThan(touched.indexOf('insert'));
  });

  it(`refuses an eleventh — a contact holds at most ${MAX_REQUIREMENTS_PER_CONTACT}`, async () => {
    const { db, touched } = fakeDb([[head()], [{ id: contactId }], [{ n: MAX_REQUIREMENTS_PER_CONTACT }]]);
    await expect(createBuyerRequirement(db, agent, contactId, brief)).rejects.toSatisfy(code('invalid'));
    expect(touched).not.toContain('insert');
  });

  it('an admin writes one on somebody else’s contact', async () => {
    const { db } = fakeDb([[head()], [{ id: contactId }], [{ n: 0 }], [{ id: reqId }], []]);
    await expect(createBuyerRequirement(db, owner, contactId, brief)).resolves.toEqual({ id: reqId });
  });

  it('refuses an agent who only sees the contact through a lead, and writes nothing', async () => {
    const { db, touched } = fakeDb([[head()]]);
    await expect(createBuyerRequirement(db, other, contactId, brief)).rejects.toSatisfy(code('forbidden'));
    expect(touched).not.toContain('insert');
  });

  it('refuses a read-only member, even one the contact is assigned to', async () => {
    const { db, touched } = fakeDb([[head({ assignedTo: 'u-ro' })]]);
    await expect(createBuyerRequirement(db, readOnly, contactId, brief)).rejects.toSatisfy(code('forbidden'));
    expect(touched).not.toContain('insert');
  });

  it('a contact outside the agency, or one they cannot see, is not found — never "forbidden"', async () => {
    const missing = fakeDb([[]]);
    await expect(createBuyerRequirement(missing.db, agent, contactId, brief)).rejects.toSatisfy(code('not_found'));
    const unseen = fakeDb([[head({ assignedTo: 'u-owner', leadAssigneeIds: null })]]);
    await expect(createBuyerRequirement(unseen.db, other, contactId, brief)).rejects.toSatisfy(code('not_found'));
    expect(unseen.touched).not.toContain('insert');
  });

  it('refuses a bad brief before opening a transaction', async () => {
    const { db, touched } = fakeDb([[head()]]);
    await expect(createBuyerRequirement(db, agent, contactId, { priceMin: 2, priceMax: 1 })).rejects.toSatisfy(code('invalid'));
    expect(touched).not.toContain('for');
  });

  it('an edit of a brief that is gone (or another contact’s) is not found, and records nothing', async () => {
    const { db, values } = fakeDb([[head()], []]);
    await expect(updateBuyerRequirement(db, agent, contactId, reqId, brief)).rejects.toSatisfy(code('not_found'));
    expect(values).toEqual([]);
  });

  it('every write asks the same rule: pause and remove refuse the lead-only agent too', async () => {
    const paused = fakeDb([[head()]]);
    await expect(setBuyerRequirementStatus(paused.db, other, contactId, reqId, 'paused')).rejects.toSatisfy(code('forbidden'));
    const removed = fakeDb([[head()]]);
    await expect(deleteBuyerRequirement(removed.db, other, contactId, reqId)).rejects.toSatisfy(code('forbidden'));
    expect([...paused.touched, ...removed.touched]).not.toContain('update');
    expect(removed.touched).not.toContain('delete');
  });

  it('removing one leaves a line saying what it was', async () => {
    const gone = {
      id: reqId, agencyId: agencyA, contactId, channel: 'rent', priceMin: null, priceMax: '650.00', minBedrooms: 2,
      minBathrooms: null, suburbs: ['Newtown'], propertyTypes: [], note: null, status: 'active', createdBy: 'u-agent',
      createdAt: new Date(), updatedAt: new Date(),
    };
    const { db, values } = fakeDb([[head()], [gone], []]);
    await deleteBuyerRequirement(db, agent, contactId, reqId);
    expect(values[0]).toMatchObject({ kind: 'requirement_removed', payload: { requirementId: reqId, summary: 'Renting · up to $650/wk · 2+ bed · Newtown' } });
  });
});
