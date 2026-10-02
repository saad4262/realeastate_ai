import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { listAgencyLeads, LeadError } from './list-leads';

const agencyA = '11111111-1111-1111-1111-111111111111';

const owner: Actor = { userId: 'u-owner', agencyId: agencyA, membershipRole: 'owner' };
const agent: Actor = { userId: 'u-agent', agencyId: agencyA, membershipRole: 'agent' };
const noAgency: Actor = { userId: 'u-none' };

/**
 * Records the WHERE it was handed as well as answering with rows.
 *
 * The filter is the whole point of this read — an assistant must not be handed
 * offers — and a fake that only returns rows would let the filter be deleted
 * while every assertion still passed. It cannot tell whether the clause is
 * CORRECT; Postgres answers that and `pnpm smoke` asks it. What it can prove is
 * that a clause was built at all, and from the permission rather than nothing.
 */
function fakeDb(rows: unknown[]) {
  const wheres: unknown[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'offset']) {
    chain[m] = () => chain;
  }
  const dialect = new PgDialect();
  chain.where = (clause: SQL) => {
    // Rendered, not stored: a drizzle SQL object is circular and cannot be
    // stringified, and the rendered text is what Postgres actually receives.
    wheres.push(dialect.sqlToQuery(clause).sql);
    return chain;
  };
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
  return { db: chain as unknown as Db, wheres, touched: () => wheres.length > 0 };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'lead-1',
  kind: 'enquiry',
  status: 'new',
  name: 'Jane Buyer',
  email: 'jane@example.test',
  phone: '0412 884 920',
  message: 'I would like to arrange an inspection.',
  offerAmount: null,
  propertyId: 'p-1',
  listingId: 'l-1',
  createdAt: new Date('2026-09-30T02:00:00Z'),
  unit: null,
  streetNumber: '32',
  street: 'Henry Street',
  suburb: 'Pakenham',
  state: 'VIC',
  postcode: '3810',
  totalCount: '2',
  unreadCount: '1',
  offerCount: '1',
  ...over,
});

describe('the agency lead inbox', () => {
  it('refuses an actor with no agency before touching the database', async () => {
    const { db, touched } = fakeDb([]);
    await expect(listAgencyLeads(db, noAgency)).rejects.toBeInstanceOf(LeadError);
    expect(touched()).toBe(false);
  });

  it('builds a row from the property, not from the listing', async () => {
    // An offer has no listing to take an address from — that is why a lead is
    // anchored to property_id (docs/adr/0012) and why one list can hold both.
    const { db } = fakeDb([row({ listingId: null, kind: 'offer', offerAmount: '905000.00' })]);
    const page = await listAgencyLeads(db, owner);

    expect(page.rows[0]?.address).toBe('32 Henry Street, Pakenham, VIC 3810');
    expect(page.rows[0]?.listingId).toBeNull();
    expect(page.rows[0]?.offerAmount).toBe(905_000);
  });

  it('keeps a non-offer amount null rather than zero', async () => {
    // Number(null) is 0, which would render as an offer of nothing.
    const { db } = fakeDb([row()]);
    const page = await listAgencyLeads(db, owner);
    expect(page.rows[0]?.offerAmount).toBeNull();
  });

  it('turns the driver s bigint strings into numbers', async () => {
    // count() returns bigint and the driver hands it back as a string, so these
    // arrive as "2" while the type says number. The console header read
    // "Live 31" the last time this was missed.
    const { db } = fakeDb([row()]);
    const page = await listAgencyLeads(db, owner);
    expect(page.counts).toEqual({ total: 2, unread: 1, offers: 1 });
    expect(typeof page.counts.total).toBe('number');
  });

  it('reports an empty inbox as zero rather than undefined', async () => {
    // Window functions have nothing to project over an empty result.
    const { db } = fakeDb([]);
    const page = await listAgencyLeads(db, owner);
    expect(page.counts).toEqual({ total: 0, unread: 0, offers: 0 });
  });

  /**
   * The disclosure rule, which is the reason this read exists rather than a
   * plain select.
   */
  describe('who may see a private offer', () => {
    it('tells the screen whether to draw the Offers tab at all', async () => {
      // Returned rather than recomputed in a component — a second role check in
      // the UI is what non-negotiable #2 forbids.
      const { db } = fakeDb([row()]);
      expect((await listAgencyLeads(db, owner)).maySeeOffers).toBe(true);

      const { db: agentDb } = fakeDb([row()]);
      expect((await listAgencyLeads(agentDb, agent)).maySeeOffers).toBe(false);
    });

    it('excludes offers in SQL for an actor who may not see them', async () => {
      /**
       * The rendered statement, so this asserts what Postgres is told rather
       * than what the function meant. An actor without the permission does not
       * see offers filtered out of their counts — they see an inbox in which
       * offers never existed, because a visible "3 hidden" would disclose most
       * of what the restriction withholds.
       */
      const { db: agentDb, wheres: agentWheres } = fakeDb([row()]);
      await listAgencyLeads(agentDb, agent);
      // agentWheres also holds the listing_agent subquery's own WHERE, which
      // the fake records first — the outer statement is the one with the kind.
      expect(agentWheres.join(' ')).toMatch(/"kind" <> /);

      const { db: ownerDb, wheres: ownerWheres } = fakeDb([row()]);
      await listAgencyLeads(ownerDb, owner);
      // An admin gets no such clause — every kind is theirs to read.
      expect(String(ownerWheres[0])).not.toMatch(/"kind" <> /);
      expect(String(ownerWheres[0])).toMatch(/"agency_id" = /);
    });

    it("narrows an agent's inbox to their leads in SQL, and leaves an admin's whole", async () => {
      /**
       * ADR 0014. In the statement, so the tab counts — window functions over
       * the same scan — describe the agent's leads and never the agency's.
       */
      const { db: agentDb, wheres: agentWheres } = fakeDb([row()]);
      await listAgencyLeads(agentDb, agent);
      const agentSql = agentWheres.join(' ');
      expect(agentSql).toMatch(/"assigned_to" = \$/);
      expect(agentSql).toMatch(/"lead"\."listing_id" in /);
      // The subquery's own WHERE, which the fake records separately: the
      // listings are the ones THIS agent is named on.
      expect(agentSql).toMatch(/"listing_agent"\."user_id" = /);

      const { db: ownerDb, wheres: ownerWheres } = fakeDb([row()]);
      await listAgencyLeads(ownerDb, owner);
      expect(ownerWheres.join(' ')).not.toMatch(/listing_agent|"assigned_to"/);
    });

    it('refuses the offers tab outright instead of showing an empty one', async () => {
      /**
       * An empty page would read as "no offers yet" to somebody who simply may
       * not see them, and they would stop looking. A refusal is honest about
       * which of the two it is.
       */
      const { db } = fakeDb([]);
      await expect(listAgencyLeads(db, agent, { kind: 'offer' })).rejects.toBeInstanceOf(LeadError);
    });

    it('lets an admin ask for the offers tab', async () => {
      const { db } = fakeDb([row({ kind: 'offer', offerAmount: '905000.00', listingId: null })]);
      const page = await listAgencyLeads(db, owner, { kind: 'offer' });
      expect(page.rows[0]?.kind).toBe('offer');
    });
  });
});
