import { describe, expect, it } from 'vitest';
import { consolePage } from './console-page';
import { listAgencyListingsPage } from './list-listings';

describe('the console listings page', () => {
  it('reads a 1-based page number and refuses anything else', () => {
    expect(consolePage(undefined)).toBe(1);
    expect(consolePage('1')).toBe(1);
    expect(consolePage('7')).toBe(7);
    // A page number is the only thing that can widen the query, so everything
    // that is not one falls back to the first page rather than to NaN — which
    // reaches the database as `offset NaN`.
    for (const bad of ['0', '-3', '2.5', 'abc', '', 'Infinity', '1e9999']) {
      expect(consolePage(bad)).toBe(1);
    }
  });

  it('takes the first value when a query string repeats the key', () => {
    expect(consolePage(['3', '9'])).toBe(3);
  });
});

describe('SQL counts arrive as numbers', () => {
  /**
   * count() is bigint and the driver returns bigint as a string, so these come
   * back as "3" however the select is typed. The type says number; only this
   * says so at runtime.
   *
   * It is not cosmetic. The console's optimistic counter does `live + 1` when
   * a listing is published, and "3" + 1 is "31".
   */
  it('a string count is coerced before it reaches arithmetic', async () => {
    const rows = [
      { id: 'l-1', suburb: 'Pakenham', state: 'VIC', postcode: '3810', channel: 'sale',
        status: 'live', agentNames: [],
        totalCount: '3', liveCount: '3', draftCount: '0' },
    ];
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']) {
      chain[m] = () => chain;
    }
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);

    const { counts } = await listAgencyListingsPage(
      chain as never,
      { userId: 'u-1', agencyId: '11111111-1111-1111-1111-111111111111', membershipRole: 'owner' },
      { limit: 25 },
    );

    expect(counts).toEqual({ total: 3, live: 3, draft: 0 });
    for (const v of Object.values(counts)) expect(typeof v).toBe('number');
    // The failure this exists for, spelled out.
    expect(counts.live + 1).toBe(4);
  });
});
