import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { createListing } from './create-listing';
import { deleteListing } from './delete-listing';
import { listAgencyListings, getAgencyListing } from './list-listings';
import { setListingStatus } from './publish-listing';
import { updateListing } from './update-listing';
import {
  createListingInputSchema,
  formatAddress,
  isListingError,
  listingDraftSchema,
  propertyDraftSchema,
  soldDetailsSchema,
  toListingError,
} from './listing-schema';

const agencyA = '11111111-1111-1111-1111-111111111111';
const agencyB = '22222222-2222-2222-2222-222222222222';
const listingId = '99999999-9999-9999-9999-999999999999';

const owner: Actor = { userId: 'u-owner', agencyId: agencyA, membershipRole: 'owner' };
const agent: Actor = { userId: 'u-agent', agencyId: agencyA, membershipRole: 'agent' };
const readOnly: Actor = { userId: 'u-ro', agencyId: agencyA, membershipRole: 'read_only' };
const outsider: Actor = { userId: 'u-out', agencyId: agencyB, membershipRole: 'owner' };
const noAgency: Actor = { userId: 'u-none' };

const validInput = {
  property: {
    streetNumber: '12',
    street: 'Campbell Parade',
    suburb: 'Bondi Beach',
    state: 'NSW' as const,
    postcode: '2026',
    bedrooms: 3,
    bathrooms: 2,
  },
  listing: {
    channel: 'sale' as const,
    headline: 'Beachfront three bedder',
    priceDisplay: 'Offers over $2.4M',
    priceFrom: 2_400_000,
  },
  agentUserIds: [],
};

/** Chainable drizzle stand-in; every terminal hands back the next queued result. */
function fakeDb(results: unknown[][] = []) {
  let i = 0;
  const touched: string[] = [];
  /** What each `.set()` was handed, so a test can assert what was written. */
  const sets: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'selectDistinct', 'from', 'innerJoin', 'leftJoin', 'where',
                   'update', 'set', 'insert', 'values', 'orderBy', 'delete',
                   'onConflictDoUpdate']) {
    chain[m] = (arg: unknown) => {
      touched.push(m);
      if (m === 'set' && arg && typeof arg === 'object') {
        sets.push(arg as Record<string, unknown>);
      }
      return chain;
    };
  }
  /**
   * The writes now run inside db.transaction, so the stand-in has to offer one.
   * It hands the callback itself: these tests assert what is written and in
   * what order, and a fake that rolled anything back would be testing Postgres
   * rather than this code.
   */
  chain.transaction = (fn: (tx: unknown) => unknown) => Promise.resolve(fn(chain));
  // The advisory lock upsertProperty takes. Not a queued result: it returns
  // nothing anybody reads, and consuming a slot would shift every fixture.
  chain.execute = () => Promise.resolve([]);
  chain.limit = () => Promise.resolve(results[i++] ?? []);
  chain.returning = () => Promise.resolve(results[i++] ?? []);
  chain.then = (res: (v: unknown) => unknown) =>
    Promise.resolve(results[i++] ?? []).then(res);
  return { db: chain as unknown as Db, touched, sets };
}

describe('listing permissions', () => {
  const resource = { type: 'listing' as const, agencyId: agencyA, id: listingId };

  it('lets any active member of the agency draft a listing', () => {
    expect(can(owner, 'listing:create', resource)).toBe(true);
    expect(can(agent, 'listing:create', resource)).toBe(true);
    expect(can(readOnly, 'listing:create', resource)).toBe(true);
  });

  it("refuses another agency's owner and an actor with no membership", () => {
    expect(can(outsider, 'listing:create', resource)).toBe(false);
    expect(can(noAgency, 'listing:create', resource)).toBe(false);
  });

  it('separates creating from publishing', () => {
    // An agent not named on the listing may draft one but not push it live.
    expect(can(agent, 'listing:create', resource)).toBe(true);
    expect(can(agent, 'listing:publish', resource)).toBe(false);

    const named: Actor = { ...agent, listingAgentOf: [listingId] };
    expect(can(named, 'listing:publish', resource)).toBe(true);
    expect(can(owner, 'listing:publish', resource)).toBe(true);
  });

  it('fails closed when the actor was loaded without its listing links', () => {
    // loadActor skips listing_agent; loadListingActor is required here.
    expect(can(agent, 'listing:publish', resource)).toBe(false);
  });
});

describe('createListing guards', () => {
  it('refuses an actor with no agency before touching the database', async () => {
    const { db, touched } = fakeDb();
    await expect(createListing(db, noAgency, validInput)).rejects.toThrow(/permission/i);
    expect(touched).toEqual([]);
  });

  it('refuses someone with an agency but no active membership role', async () => {
    const { db, touched } = fakeDb();
    const lapsed: Actor = { userId: 'u-lapsed', agencyId: agencyA };
    await expect(createListing(db, lapsed, validInput)).rejects.toThrow(/permission/i);
    expect(touched).toEqual([]);
  });

  it('writes into the actor\'s own agency, so another agency is not a target', () => {
    // There is no destination parameter: a listing is always created in
    // actor.agencyId, so an outsider creating one in theirs is legitimate.
    expect(can(outsider, 'listing:create', { type: 'listing', agencyId: agencyB })).toBe(true);
    expect(can(outsider, 'listing:create', { type: 'listing', agencyId: agencyA })).toBe(false);
  });

  it('rejects a bad draft as a field error, not a raw ZodError', async () => {
    const { db } = fakeDb();
    const bad = { ...validInput, property: { ...validInput.property, postcode: '20' } };
    await expect(createListing(db, owner, bad)).rejects.toSatisfy(
      (err: unknown) =>
        isListingError(err) &&
        err.code === 'invalid_draft' &&
        /4 digits/.test(err.message),
    );
  });
});

describe('listAgencyListings guards', () => {
  it('refuses an actor with no agency', async () => {
    const { db, touched } = fakeDb();
    await expect(listAgencyListings(db, noAgency)).rejects.toThrow(/permission/i);
    expect(touched).toEqual([]);
  });

  it('refuses a single listing read without an agency', async () => {
    const { db, touched } = fakeDb();
    await expect(getAgencyListing(db, noAgency, listingId)).rejects.toThrow(/permission/i);
    expect(touched).toEqual([]);
  });
});

describe('setListingStatus guards', () => {
  it('refuses an agent who is not named on the listing', async () => {
    const { db } = fakeDb([[{ id: listingId, agencyId: agencyA }]]);
    await expect(setListingStatus(db, agent, listingId, 'live')).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'forbidden',
    );
  });

  it('refuses before any read when the actor has no agency at all', async () => {
    const { db, touched } = fakeDb();
    await expect(setListingStatus(db, noAgency, listingId, 'live')).rejects.toThrow(/permission/i);
    expect(touched).toEqual([]);
  });

  it("refuses another agency's owner on a listing that is not theirs", async () => {
    // First queued result is the listing lookup: it belongs to agency A.
    const { db } = fakeDb([[{ id: listingId, agencyId: agencyA }]]);
    await expect(setListingStatus(db, outsider, listingId, 'live')).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'forbidden',
    );
  });

  it('allows the agency owner', async () => {
    const { db } = fakeDb([
      [{ id: listingId, agencyId: agencyA }],
      [{ id: listingId, status: 'live', publishedAt: new Date() }],
    ]);
    await expect(setListingStatus(db, owner, listingId, 'live')).resolves.toMatchObject({
      listingId,
      status: 'live',
    });
  });

  it('reports a listing that is gone rather than claiming success', async () => {
    const { db } = fakeDb([[]]);
    await expect(setListingStatus(db, owner, listingId, 'live')).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'not_found',
    );
  });
});

/**
 * Recording a sale.
 *
 * The transition that carries data, and the only way sold_price and sold_date
 * are ever written — updateListing cannot reach those columns. Every refusal
 * here is checked BEFORE the listing is read, because a malformed sale is the
 * caller's mistake and there is nothing to look up for it.
 */
describe('setListingStatus records a sale', () => {
  const sold = { soldPrice: 1_200_000, soldDate: new Date('2026-06-15') };
  const found: unknown[][] = [
    [{ id: listingId, agencyId: agencyA }],
    [{ id: listingId, status: 'sold', publishedAt: new Date() }],
  ];

  it('writes the price and the date in the same statement as the status', async () => {
    const { db, sets } = fakeDb(found);
    await expect(setListingStatus(db, owner, listingId, 'sold', sold)).resolves.toMatchObject({
      listingId,
      status: 'sold',
    });

    // One write, carrying all three. A sale recorded in two statements can be
    // half-recorded, and the public timeline cannot render a sold listing with
    // no price.
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ status: 'sold', soldDate: sold.soldDate });
    // numeric columns take strings — a JS number loses precision at scale.
    expect(sets[0]?.soldPrice).toBe('1200000.00');
  });

  it('refuses a sale with no figures at all, before reading anything', async () => {
    const { db, touched } = fakeDb(found);
    await expect(setListingStatus(db, owner, listingId, 'sold')).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'invalid_draft',
    );
    expect(touched).toEqual([]);
  });

  it.each([
    ['a price of zero', { soldPrice: 0, soldDate: new Date('2026-06-15') }],
    ['a negative price', { soldPrice: -5, soldDate: new Date('2026-06-15') }],
    ['no date', { soldPrice: 1_200_000 }],
    ['a date in the future', { soldPrice: 1_200_000, soldDate: new Date(Date.now() + 86_400_000) }],
  ])('refuses %s', async (_label, bad) => {
    const { db, touched } = fakeDb(found);
    await expect(setListingStatus(db, owner, listingId, 'sold', bad)).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'invalid_draft',
    );
    expect(touched).toEqual([]);
  });

  it('names the field that was wrong, so a form can highlight it', async () => {
    const { db } = fakeDb(found);
    await expect(
      setListingStatus(db, owner, listingId, 'sold', { soldPrice: 1_200_000 }),
    ).rejects.toSatisfy((err: unknown) => isListingError(err) && err.field === 'soldDate');
  });

  it('refuses sale figures attached to a change that is not a sale', async () => {
    // A caller passing these to 'withdrawn' believes it is recording something.
    // Dropping them silently would leave the sale nowhere and return success.
    const { db, touched } = fakeDb(found);
    await expect(
      setListingStatus(db, owner, listingId, 'withdrawn', sold),
    ).rejects.toSatisfy((err: unknown) => isListingError(err) && err.code === 'invalid_draft');
    expect(touched).toEqual([]);
  });

  it('leaves the sale columns alone on every other transition', async () => {
    // A sold listing later withdrawn keeps what it sold for — the agency's
    // record of the transaction, and the public timeline's only figure.
    const { db, sets } = fakeDb([
      [{ id: listingId, agencyId: agencyA }],
      [{ id: listingId, status: 'withdrawn', publishedAt: new Date() }],
    ]);
    await setListingStatus(db, owner, listingId, 'withdrawn');
    expect(sets[0]).not.toHaveProperty('soldPrice');
    expect(sets[0]).not.toHaveProperty('soldDate');
  });

  it('refuses an agent who is not named on the listing', async () => {
    const { db } = fakeDb(found);
    await expect(setListingStatus(db, agent, listingId, 'sold', sold)).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'forbidden',
    );
  });

  it('says a sale was refused, not that publishing was', async () => {
    const { db } = fakeDb(found);
    await expect(setListingStatus(db, agent, listingId, 'sold', sold)).rejects.toThrow(
      /record a sale/i,
    );
  });
});

describe('the sale contract', () => {
  it('accepts what an agency actually types', () => {
    // Coerced, because a form hands over strings.
    const parsed = soldDetailsSchema.parse({ soldPrice: '1200000', soldDate: '2026-06-15' });
    expect(parsed.soldPrice).toBe(1_200_000);
    expect(parsed.soldDate.getUTCFullYear()).toBe(2026);
  });

  it('stays out of listingDraftSchema', () => {
    /**
     * `pnpm smoke` replays listingDraftSchema over every live row to prove the
     * site is servable. A sale field required there would turn that check red
     * on data that is perfectly correct — so a sale is a transition, not an
     * edit, and these two schemas never merge.
     */
    const parsed = listingDraftSchema.parse({
      channel: 'sale',
      headline: 'Renovated family home',
      priceDisplay: 'Offers over $1.2M',
    });
    expect(parsed).not.toHaveProperty('soldPrice');
    expect(parsed).not.toHaveProperty('soldDate');
  });
});

describe('listing contract', () => {
  it('keeps the display string and the numbers side by side', () => {
    const parsed = listingDraftSchema.parse({
      channel: 'sale',
      headline: 'Renovated family home',
      priceDisplay: 'Offers over $1.2M',
      priceFrom: 1_200_000,
    });
    // Non-negotiable #6: both are carried, and the string is never parsed.
    expect(parsed.priceDisplay).toBe('Offers over $1.2M');
    expect(parsed.priceFrom).toBe(1_200_000);
  });

  it('refuses an upper price below the lower one', () => {
    const r = listingDraftSchema.safeParse({
      channel: 'sale', headline: 'Renovated family home', priceFrom: 900_000, priceTo: 800_000,
    });
    expect(r.success).toBe(false);
    expect(toListingError(r.success ? null : r.error).field).toBe('priceTo');
  });

  it('requires a weekly rent on a rental', () => {
    const r = listingDraftSchema.safeParse({ channel: 'rent', headline: 'Renovated family home' });
    expect(r.success).toBe(false);
    expect(toListingError(r.success ? null : r.error).field).toBe('rentPw');
  });

  it('requires a four digit postcode and a suburb', () => {
    expect(propertyDraftSchema.safeParse({ suburb: 'Bondi', postcode: '2026' }).success).toBe(true);
    expect(propertyDraftSchema.safeParse({ suburb: 'Bondi', postcode: '202' }).success).toBe(false);
    expect(propertyDraftSchema.safeParse({ suburb: '', postcode: '2026' }).success).toBe(false);
  });

  it('defaults agentUserIds so a listing is never left with nobody on it', () => {
    const parsed = createListingInputSchema.parse({
      property: validInput.property,
      listing: validInput.listing,
    });
    expect(parsed.agentUserIds).toEqual([]);
  });

  it('builds an address from the parts rather than storing one', () => {
    expect(formatAddress({
      unit: '3', streetNumber: '12', street: 'Campbell Parade',
      suburb: 'Bondi Beach', state: 'NSW', postcode: '2026',
    })).toBe('3/12 Campbell Parade, Bondi Beach, NSW 2026');

    expect(formatAddress({
      suburb: 'Pakenham', state: 'VIC', postcode: '3810',
    })).toBe('Pakenham, VIC 3810');
  });
});

describe('listing:delete is narrower than listing:edit', () => {
  const resource = { type: 'listing' as const, agencyId: agencyA, id: listingId };
  const namedAgent: Actor = { ...agent, listingAgentOf: [listingId] };

  it('lets an agent named on the listing edit it but not delete it', () => {
    expect(can(namedAgent, 'listing:edit', resource)).toBe(true);
    expect(can(namedAgent, 'listing:delete', resource)).toBe(false);
  });

  it('allows the agency owner and an admin', () => {
    expect(can(owner, 'listing:delete', resource)).toBe(true);
    expect(
      can({ userId: 'u-admin', agencyId: agencyA, membershipRole: 'admin' }, 'listing:delete', resource),
    ).toBe(true);
  });

  it("refuses another agency's owner and an actor with no membership", () => {
    expect(can(outsider, 'listing:delete', resource)).toBe(false);
    expect(can(noAgency, 'listing:delete', resource)).toBe(false);
  });

  it('refuses a read-only member, who can still read', () => {
    expect(can(readOnly, 'listing:read', resource)).toBe(true);
    expect(can(readOnly, 'listing:delete', resource)).toBe(false);
  });
});

describe('updateListing guards', () => {
  const editInput = {
    // Carrying a pin keeps resolvePin off the database entirely, so these
    // assertions are about the transaction's writes and not about how many
    // queries a geocoder lookup happens to make on the way past.
    property: { ...validInput.property, latitude: -33.8908, longitude: 151.2743 },
    listing: { ...validInput.listing, headline: 'Corrected headline' },
  };

  it('refuses before any read when the actor has no agency at all', async () => {
    const { db, touched } = fakeDb();
    await expect(updateListing(db, noAgency, listingId, editInput)).rejects.toThrow(/permission/i);
    expect(touched).toEqual([]);
  });

  it('refuses an agent who is not named on the listing', async () => {
    const { db } = fakeDb([[{ id: listingId, agencyId: agencyA, propertyId: 'p1', status: 'draft' }]]);
    await expect(updateListing(db, agent, listingId, editInput)).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'forbidden',
    );
  });

  it("refuses another agency's owner on a listing that is not theirs", async () => {
    const { db } = fakeDb([[{ id: listingId, agencyId: agencyA, propertyId: 'p1', status: 'draft' }]]);
    await expect(updateListing(db, outsider, listingId, editInput)).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'forbidden',
    );
  });

  it('reports a listing that is gone rather than claiming success', async () => {
    const { db } = fakeDb([[]]);
    await expect(updateListing(db, owner, listingId, editInput)).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'not_found',
    );
  });

  it('rejects a bad draft as a field error, not a raw ZodError', async () => {
    const { db } = fakeDb([[{ id: listingId, agencyId: agencyA, propertyId: 'p1', status: 'draft' }]]);
    const bad = { property: { ...validInput.property, postcode: '20' }, listing: validInput.listing };
    await expect(updateListing(db, owner, listingId, bad)).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'invalid_draft',
    );
  });

  it('leaves the status alone, so an edit can never publish a draft', async () => {
    const { db } = fakeDb([
      [{ id: listingId, agencyId: agencyA, propertyId: 'p1', status: 'draft' }],
      // resolvePropertyId finds the same address, already pinned, so no geocode
      [{ id: 'p1', latitude: '-33.890800', ...validInput.property }],
      [],
      [{ id: listingId, status: 'draft', propertyId: 'p1' }],
    ]);
    await expect(updateListing(db, owner, listingId, editInput)).resolves.toMatchObject({
      listingId,
      status: 'draft',
      addressChanged: false,
    });
  });

  it('reports an address change, because the listing moved property rows', async () => {
    const { db } = fakeDb([
      [{ id: listingId, agencyId: agencyA, propertyId: 'p-old', status: 'draft' }],
      [{ id: 'p-new', latitude: '-33.890800', ...validInput.property }],
      [],
      [{ id: listingId, status: 'draft', propertyId: 'p-new' }],
    ]);
    await expect(updateListing(db, owner, listingId, editInput)).resolves.toMatchObject({
      addressChanged: true,
    });
  });
});

describe('deleteListing guards', () => {
  it('refuses before any read when the actor has no agency at all', async () => {
    const { db, touched } = fakeDb();
    await expect(deleteListing(db, noAgency, listingId)).rejects.toThrow(/permission/i);
    expect(touched).toEqual([]);
  });

  it('refuses an agent even when they are named on the listing', async () => {
    const { db } = fakeDb([[{ id: listingId, agencyId: agencyA, propertyId: 'p1', status: 'draft' }]]);
    const namedAgent: Actor = { ...agent, listingAgentOf: [listingId] };
    await expect(deleteListing(db, namedAgent, listingId)).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'forbidden',
    );
  });

  it("refuses another agency's owner", async () => {
    const { db } = fakeDb([[{ id: listingId, agencyId: agencyA, propertyId: 'p1', status: 'draft' }]]);
    await expect(deleteListing(db, outsider, listingId)).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'forbidden',
    );
  });

  it('refuses a live listing and says to withdraw it first', async () => {
    const { db } = fakeDb([[{ id: listingId, agencyId: agencyA, propertyId: 'p1', status: 'live' }]]);
    await expect(deleteListing(db, owner, listingId)).rejects.toSatisfy(
      (err: unknown) =>
        isListingError(err) && err.code === 'conflict' && /withdraw/i.test(err.message),
    );
  });

  it('refuses a sold listing outright — it is the record of the sale', async () => {
    const { db } = fakeDb([[{ id: listingId, agencyId: agencyA, propertyId: 'p1', status: 'sold' }]]);
    await expect(deleteListing(db, owner, listingId)).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'conflict',
    );
  });

  it('deletes a draft and keeps the property, which outlives every ad', async () => {
    const { db } = fakeDb([
      [{ id: listingId, agencyId: agencyA, propertyId: 'p1', status: 'draft' }],
      [{ id: listingId, propertyId: 'p1' }],
    ]);
    await expect(deleteListing(db, owner, listingId)).resolves.toEqual({
      listingId,
      propertyId: 'p1',
    });
  });

  it('deletes a withdrawn listing, since withdraw is the step before it', async () => {
    const { db } = fakeDb([
      [{ id: listingId, agencyId: agencyA, propertyId: 'p1', status: 'withdrawn' }],
      [{ id: listingId, propertyId: 'p1' }],
    ]);
    await expect(deleteListing(db, owner, listingId)).resolves.toMatchObject({ listingId });
  });

  it('reports a listing that is already gone rather than claiming success', async () => {
    const { db } = fakeDb([[]]);
    await expect(deleteListing(db, owner, listingId)).rejects.toSatisfy(
      (err: unknown) => isListingError(err) && err.code === 'not_found',
    );
  });
});

/**
 * The console row's numeric columns.
 *
 * Not an abstract edge case: a column missing from the select arrives as
 * `undefined`, `Number(undefined)` is NaN, and NaN passes every `!== null`
 * guard downstream — which is how the agency console printed a sold listing's
 * price as "$NaN" in its own book.
 */
describe('a console row never carries NaN', () => {
  it('turns a missing numeric into null, not NaN', () => {
    const rows = [
      {
        id: listingId, channel: 'sale', status: 'sold', headline: null,
        priceDisplay: null, priceFrom: '800', priceTo: null, rentPw: null,
        // The shape that caused it: present in the type, absent from the row.
        soldPrice: undefined, soldDate: null,
        createdAt: new Date(), unit: null, streetNumber: '32', street: 'Henry Street',
        suburb: 'Pakenham', state: 'VIC', postcode: '3810',
        bedrooms: null, bathrooms: undefined, carSpaces: null, propertyType: null,
        agencyName: 'Test', agentNames: [], totalCount: 1, liveCount: 0, draftCount: 0,
      },
    ];
    const { db } = fakeDb([rows]);

    return listAgencyListings(db, owner).then((out) => {
      const row = out[0];
      expect(row?.soldPrice).toBeNull();
      expect(row?.bathrooms).toBeNull();
      expect(Number.isNaN(row?.soldPrice as number)).toBe(false);
      // And a real figure still survives the same path.
      expect(row?.priceFrom).toBe(800);
    });
  });
});
