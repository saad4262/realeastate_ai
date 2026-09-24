import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { searchPublicListings } from './search-listings';

/** Renders a where-clause to the SQL Postgres would actually receive. */
const dialect = new PgDialect();

/** Renders any SQL fragment to the text Postgres would receive. */
function render(clause: unknown): string {
  const q = dialect.sqlToQuery(clause as SQL);
  return `${q.sql} ${JSON.stringify(q.params)}`.toLowerCase();
}

/**
 * These assert the SQL that is built, not the rows that come back.
 *
 * The union of "in this suburb" and "within this radius" is the one piece of
 * this search that is easy to get wrong in a way nobody notices: both wrong
 * versions still return listings, just the wrong set. A live-data test would
 * pass on a database whose suburbs all happen to be smaller than the radius.
 */
function capturingDb() {
  let where: SQL | null = null;
  let order: unknown[] = [];
  let limit: number | null = null;
  let offset: number | null = null;

  let selection: Record<string, unknown> = {};

  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin']) {
    chain[m] = () => chain;
  }
  chain.select = (cols: Record<string, unknown>) => {
    selection = cols;
    return chain;
  };
  chain.where = (clause: SQL) => {
    where = clause;
    return chain;
  };
  chain.orderBy = (...clauses: unknown[]) => {
    order = clauses;
    return chain;
  };
  chain.limit = (n: number) => {
    limit = n;
    return chain;
  };
  chain.offset = (n: number) => {
    offset = n;
    return Promise.resolve([]);
  };

  return {
    db: chain as unknown as Db,
    /** The rendered statement plus its parameters, lowercased for matching. */
    sql: () => {
      if (!where) return '';
      return render(where);
    },
    /** Every ORDER BY term, rendered, in order. */
    orderBy: () => order.map(render),
    limit: () => limit,
    offset: () => offset,
    selection: () => selection,
  };
}

const PAKENHAM = { suburb: 'Pakenham', state: 'VIC', postcode: '3810' };
const CENTRE = { lat: -38.0791, lng: 145.4842, radiusKm: 10 };

describe('suburb and radius combine rather than replace', () => {
  it('matches the suburb exactly when no radius is asked for', async () => {
    const { db, sql } = capturingDb();
    await searchPublicListings(db, PAKENHAM);
    const text = sql();

    expect(text).toContain('pakenham');
    expect(text).toContain('vic');
    expect(text).toContain('3810');
    // No circle was requested, so none is drawn.
    expect(text).not.toContain('st_dwithin');
  });

  it('keeps the whole suburb AND adds the radius when both are given', async () => {
    const { db, sql } = capturingDb();
    await searchPublicListings(db, { ...PAKENHAM, near: CENTRE });
    const text = sql();

    // Both halves present...
    expect(text).toContain('pakenham');
    expect(text).toContain('st_dwithin');
    // ...joined by or, not and. Pakenham is about 8km across, so ANDing them
    // would drop homes on its edges from a search for their own suburb.
    expect(text).toContain('or');
  });

  it('is a plain radius search when no suburb was named', async () => {
    const { db, sql } = capturingDb();
    await searchPublicListings(db, { near: CENTRE });
    const text = sql();

    expect(text).toContain('st_dwithin');
    expect(text).not.toContain('pakenham');
  });

  it('ignores a radius the caller gave no centre for', async () => {
    const { db, sql } = capturingDb();
    await searchPublicListings(db, PAKENHAM);
    expect(sql()).not.toContain('st_dwithin');
  });

  it('does not require state or postcode to match a suburb', async () => {
    const { db, sql } = capturingDb();
    await searchPublicListings(db, { suburb: 'Pakenham' });
    const text = sql();

    expect(text).toContain('pakenham');
    // Nothing was said about the state, so nothing is asserted about it —
    // otherwise a suburb typed by hand would match nothing.
    expect(text).not.toContain('3810');
  });

  it('ANDs a keyword over the location, which is why a place label must not be one', async () => {
    const { db, sql } = capturingDb();
    await searchPublicListings(db, { ...PAKENHAM, near: CENTRE, text: 'pakenham' });
    const text = sql();

    // The union is still there…
    expect(text).toContain('st_dwithin');
    // …but the keyword narrows everything, including the listings the radius
    // just brought in. That is correct for a real keyword and catastrophic for
    // a place's own name: the search box holds "Pakenham" after the suburb is
    // picked, and sending it as a keyword too deleted every neighbouring suburb
    // from a 50 km search. apps/web discounts the label before it gets here.
    expect(text).toContain('like');
  });

  it('reads rent from rent_pw and sale from price_from', async () => {
    const { db, sql } = capturingDb();
    await searchPublicListings(db, { channel: 'rent', priceTo: 900 });
    expect(sql()).toContain('rent_pw');

    const sale = capturingDb();
    await searchPublicListings(sale.db, { channel: 'sale', priceTo: 900_000 });
    expect(sale.sql()).toContain('price_from');
  });
});

/**
 * Paging is only meaningful if the order is total.
 *
 * Without a unique tiebreaker Postgres may return tied rows in a different
 * order for the same query, so a listing sitting on a page boundary can appear
 * on both pages or on neither. Ties are not rare here: two listings published
 * in the same second, two priced the same, and every listing with no price at
 * all sharing the NULLS LAST bucket.
 */
describe('the result order is deterministic', () => {
  const sorts = [
    ['newest', undefined],
    ['price_asc', undefined],
    ['price_desc', undefined],
    [undefined, undefined],
    [undefined, CENTRE],
  ] as const;

  for (const [sort, near] of sorts) {
    it(`ends on the listing id for sort=${sort ?? 'default'}${near ? ' with a centre' : ''}`, async () => {
      const { db, orderBy } = capturingDb();
      await searchPublicListings(db, { ...PAKENHAM, sort, near });

      const terms = orderBy();
      expect(terms.length).toBeGreaterThan(1);
      expect(terms[terms.length - 1]).toContain('"id"');
    });
  }
});

describe('paging', () => {
  it('asks for the rows of the page it was given', async () => {
    const { db, limit, offset } = capturingDb();
    await searchPublicListings(db, { ...PAKENHAM, limit: 24, offset: 48 });

    expect(limit()).toBe(24);
    expect(offset()).toBe(48);
  });

  it('starts at the beginning when no offset is asked for', async () => {
    const { db, offset } = capturingDb();
    await searchPublicListings(db, PAKENHAM);
    expect(offset()).toBe(0);
  });

  it('never lets a caller ask for a negative offset', async () => {
    const { db, offset } = capturingDb();
    await searchPublicListings(db, { ...PAKENHAM, offset: -10 });
    expect(offset()).toBe(0);
  });

  it('counts the whole match in the same statement, not a second one', async () => {
    const { db, selection } = capturingDb();
    await searchPublicListings(db, PAKENHAM);

    // The total rides on the row selection as a window function. If it ever
    // becomes its own SELECT, a paged search costs two round trips to the
    // database region and query-count.test.ts is the one that says so.
    const total = selection().totalCount;
    expect(total).toBeDefined();
    expect(render(total)).toContain('count(*) over()');
  });
});
