import { describe, expect, it } from 'vitest';
import { getTableName, is, Table } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { createListing } from './create-listing';
import { updateListing } from './update-listing';
import { isListingError } from './listing-schema';
import type { Actor } from '../permissions';

const agencyA = '11111111-1111-1111-1111-111111111111';
const listingId = '99999999-9999-9999-9999-999999999999';
const owner: Actor = { userId: 'u-owner', agencyId: agencyA, membershipRole: 'owner' };

const property = {
  streetNumber: '12',
  street: 'Campbell Parade',
  suburb: 'Bondi Beach',
  state: 'NSW' as const,
  postcode: '2026',
  // A pin the caller carries keeps the geocoder out of this entirely.
  latitude: -33.8908,
  longitude: 151.2743,
};

const listing = {
  channel: 'sale' as const,
  headline: 'Beachfront three bedder',
  priceFrom: 2_400_000,
};

/**
 * A stand-in that records what was written and whether it was inside a
 * transaction that was allowed to finish.
 *
 * The point of these tests is the guarantee, not the SQL: nothing reaches the
 * database unless the last step succeeds. So the fake refuses to "commit" when
 * the callback throws, and every write it saw in that attempt is discarded —
 * which is what Postgres does, and what the old code was not asking it to do.
 */
function txDb(opts: { failOn: 'agents' | null; results?: unknown[][] } = { failOn: null }) {
  const committed: string[] = [];
  let pending: string[] = [];
  let inTransaction = false;
  let i = 0;
  const results = opts.results ?? [];

  const chain: Record<string, unknown> = {};
  const record = (what: string) => {
    if (!inTransaction) committed.push(`OUTSIDE:${what}`);
    else pending.push(what);
  };

  for (const m of ['select', 'selectDistinct', 'from', 'innerJoin', 'leftJoin', 'where', 'set',
                   'values', 'orderBy', 'onConflictDoUpdate']) {
    chain[m] = () => chain;
  }
  /** Drizzle keeps the table name behind a symbol; this is its own accessor. */
  const nameOf = (t: unknown) => (is(t, Table) ? getTableName(t) : 'row');

  chain.insert = (t: unknown) => {
    const name = nameOf(t);
    record(`insert:${name}`);
    // Inserting listing_agent is the step that legitimately fails: the ids may
    // not belong to the agency. That is the failure the guarantee is about.
    if (opts.failOn === 'agents' && name === 'listing_agent') {
      throw new Error('None of the selected agents belong to this agency');
    }
    return chain;
  };
  chain.update = (t: unknown) => {
    record(`update:${nameOf(t)}`);
    return chain;
  };
  chain.delete = (t: unknown) => {
    record(`delete:${nameOf(t)}`);
    return chain;
  };

  chain.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    inTransaction = true;
    pending = [];
    try {
      const out = await fn(chain);
      committed.push(...pending);
      return out;
    } finally {
      // A throw leaves `pending` unmerged — the rollback.
      inTransaction = false;
      pending = [];
    }
  };

  chain.limit = () => Promise.resolve(results[i++] ?? []);
  chain.returning = () => Promise.resolve(results[i++] ?? []);
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(results[i++] ?? []).then(res);

  return { db: chain as unknown as Db, committed };
}

describe('nothing is written unless the last step succeeds', () => {
  it('creating a listing writes nothing when the agents cannot be attached', async () => {
    const { db, committed } = txDb({
      failOn: 'agents',
      results: [
        [],                                   // no existing property
        [{ id: 'p1' }],                       // the property insert
        [{ id: listingId }],                  // the listing insert
        [],                                   // agent lookup
      ],
    });

    await expect(
      createListing(db, owner, { property, listing, agentUserIds: [] }),
    ).rejects.toThrow();

    // The property and the listing were attempted, and neither survived.
    expect(committed).toEqual([]);
  });

  it('creating a listing commits every row together when it succeeds', async () => {
    const { db, committed } = txDb({
      failOn: null,
      results: [
        [],
        [{ id: 'p1' }],
        [{ id: listingId }],
        [{ userId: 'u-owner', name: 'Owner', email: 'o@example.com', phone: '', displayName: null }],
      ],
    });

    await expect(
      createListing(db, owner, { property, listing, agentUserIds: [] }),
    ).resolves.toMatchObject({ listingId, status: 'draft' });

    expect(committed).toContain('insert:property');
    expect(committed).toContain('insert:listing');
    expect(committed).toContain('insert:listing_agent');
    // Nothing escaped the transaction.
    expect(committed.filter((w) => w.startsWith('OUTSIDE:'))).toEqual([]);
  });

  it('editing a listing writes nothing when the agents cannot be attached', async () => {
    const { db, committed } = txDb({
      failOn: 'agents',
      results: [
        [{ id: listingId, agencyId: agencyA, propertyId: 'p1', status: 'draft' }],
        [{ id: 'p1', latitude: '-33.890800' }],
        [],
        [{ id: listingId, status: 'draft', propertyId: 'p1' }],
        [],
      ],
    });

    await expect(
      updateListing(db, owner, listingId, {
        property,
        listing,
        agentUserIds: ['22222222-2222-2222-2222-222222222222'],
      }),
    ).rejects.toThrow();

    // The property update and the listing update both happened inside the
    // transaction and both went with it.
    expect(committed).toEqual([]);
  });

  it('reports the failure rather than swallowing it', async () => {
    const { db } = txDb({
      failOn: 'agents',
      results: [[], [{ id: 'p1' }], [{ id: listingId }], []],
    });

    await expect(
      createListing(db, owner, { property, listing, agentUserIds: [] }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof Error || isListingError(err),
    );
  });
});
