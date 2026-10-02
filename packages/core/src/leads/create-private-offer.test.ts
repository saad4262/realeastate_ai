import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import { createPrivateOffer, OfferError } from './create-private-offer';

/**
 * A stand-in that records the statement instead of running it.
 *
 * `createPrivateOffer` is one hand-written `INSERT ... SELECT`, so there is no
 * `.values()` object to inspect the way `create-enquiry.test.ts` does. What
 * there is, is the statement itself — and `PgDialect` renders it to the exact
 * text and parameters Postgres would receive. So these tests can assert what
 * the database is actually told, which for this function is the whole point:
 * the destination and the identity must come from the server, never the caller.
 *
 * What it cannot do is decide whether the WHERE clause is *right*. Postgres
 * answers that, and `pnpm smoke` asks it.
 */
function fakeDb(rows: unknown[] = [{ id: 'lead-1', agency_id: 'agency-real' }]) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const dialect = new PgDialect();
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = () => chain;
  chain.execute = (query: SQL) => {
    statements.push(dialect.sqlToQuery(query));
    return Promise.resolve(rows);
  };
  return { db: chain as unknown as DbOrTx, statements };
}

const PROPERTY = 'e99d1a30-833c-4150-a641-27d0982a5aad';

/** From the session. The form never gets to say who this is. */
const OFFERER = { userId: 'd0314b2e-6e3b-4830-8bd3-3dc45aebb78b', email: 'jane@example.test' };

const VALID = {
  name: 'Jane Buyer',
  phone: '0412 884 920',
  message: 'I have been watching this street for a while and would like to buy.',
  offerAmount: 905_000,
};

describe('a private offer', () => {
  it('records the offer and returns the agency it resolved', async () => {
    const { db, statements } = fakeDb();
    const result = await createPrivateOffer(db, PROPERTY, OFFERER, VALID);

    expect(result.leadId).toBe('lead-1');
    expect(result.agencyId).toBe('agency-real');
    // The parsed offer comes back so the notification quotes what was stored,
    // not the caller's raw input.
    expect(result.offer).toMatchObject({ name: 'Jane Buyer', offerAmount: 905_000 });
    // One statement. The check and the write are the same one on purpose —
    // see the function's note on the window a two-step version leaves open.
    expect(statements).toHaveLength(1);
  });

  /**
   * The one that matters most.
   *
   * An offer is a financial approach to a private owner. The address it is about
   * is the only thing the browser chooses; the agency comes from the last sale
   * and the identity comes from the session. A form that could name either would
   * let anyone file an offer into any agency's inbox under anyone's name.
   */
  it('takes the identity from the session and never from the form', async () => {
    const { db, statements } = fakeDb();
    await createPrivateOffer(db, PROPERTY, OFFERER, {
      ...VALID,
      email: 'attacker@example.invalid',
      userId: 'somebody-else',
      agencyId: 'agency-attacker',
    });

    const params = statements[0]?.params ?? [];
    expect(params).toContain('jane@example.test');
    expect(params).toContain(OFFERER.userId);
    // The form's own email and ids reach the database in no form at all.
    expect(params).not.toContain('attacker@example.invalid');
    expect(params).not.toContain('somebody-else');
    expect(params).not.toContain('agency-attacker');
  });

  it('never lets the caller choose the kind, the status or the listing', async () => {
    const { db, statements } = fakeDb();
    await createPrivateOffer(db, PROPERTY, OFFERER, {
      ...VALID,
      kind: 'enquiry',
      status: 'closed',
      listingId: 'listing-1',
    });

    const statement = statements[0]?.sql ?? '';
    // Written into the statement itself, below anywhere a caller can reach. A
    // caller choosing its own status could file an offer as already closed.
    expect(statement).toContain("'offer'::lead_kind");
    expect(statement).toContain("'new'::lead_status");
    // An offer came through no advertisement, whatever the form claims.
    expect(statement).toContain('null::uuid');
    expect(statements[0]?.params).not.toContain('listing-1');
  });

  it('orders by the same expression the public timeline does', async () => {
    const { db, statements } = fakeDb();
    await createPrivateOffer(db, PROPERTY, OFFERER, VALID);

    /**
     * The agency this offer reaches has to be the one the property page credits
     * at the top of its history. Both orderings come from HISTORY_RANK, so this
     * asserts the shared expression really did reach the statement rather than
     * somebody retyping a coalesce here.
     */
    const statement = statements[0]?.sql ?? '';
    expect(statement).toContain('coalesce');
    expect(statement).toMatch(/order by .*sold_date.*published_at/s);
    expect(statement).toContain('limit 1');
  });

  it('refuses an address the query returns nothing for', async () => {
    // On the market, no sale ever recorded, or no such property. All three come
    // back as zero rows and all three get one sentence, because telling them
    // apart tells a uuid-guesser which addresses exist and which are for sale.
    const { db } = fakeDb([]);
    await expect(createPrivateOffer(db, PROPERTY, OFFERER, VALID)).rejects.toSatisfy(
      (err: unknown) => err instanceof OfferError && /not open to private offers/.test(err.message),
    );
  });

  it.each([
    ['no amount', { offerAmount: undefined }, 'offerAmount'],
    ['a zero offer', { offerAmount: 0 }, 'offerAmount'],
    ['a negative offer', { offerAmount: -5 }, 'offerAmount'],
    ['cents', { offerAmount: 905_000.5 }, 'offerAmount'],
    ['words instead of a number', { offerAmount: 'lots' }, 'offerAmount'],
    ['no name', { name: '' }, 'name'],
    ['a message too short to act on', { message: 'hi' }, 'message'],
  ])('refuses %s before touching the database', async (_label, bad, field) => {
    const { db, statements } = fakeDb();
    await expect(
      createPrivateOffer(db, PROPERTY, OFFERER, { ...VALID, ...bad }),
    ).rejects.toSatisfy((err: unknown) => err instanceof OfferError && err.field === field);
    // Parsed first, so a malformed offer costs no query at all.
    expect(statements).toEqual([]);
  });

  it('keeps a missing phone number as null rather than the string "null"', async () => {
    const { db, statements } = fakeDb();
    const { phone: _dropped, ...noPhone } = VALID;
    await createPrivateOffer(db, PROPERTY, OFFERER, noPhone);
    expect(statements[0]?.params).toContain(null);
    expect(statements[0]?.params).not.toContain('null');
  });
});
