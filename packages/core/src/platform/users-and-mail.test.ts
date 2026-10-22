import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { recordSiteActivity } from '../activity/site-activity';
import { platformAttention } from './attention';
import { emailActivity } from './email-activity';
import { getSiteUser, getSiteUserChat, listSiteUsers, siteInsights, siteTrend } from './site-users';

/**
 * ADR 0051: the Users section, site activity, email activity and the admin home's panels.
 *  - an agency owner (and a view, where the read is platform-wide) is refused, asking nothing;
 *  - each read is a fixed number of statements, whatever the row count;
 *  - recording: the browser's body is validated, an anonymous search keeps no filters, a signed-in
 *    one does, and a listing view's agency comes from the database (one statement, no write if the
 *    listing is not public).
 */

const A = '11111111-1111-1111-1111-111111111111';
const U = '33333333-3333-3333-3333-333333333333';
const admin: Actor = { userId: '99999999-9999-9999-9999-999999999999', platformAdmin: true };
const owner: Actor = { userId: 'u', agencyId: A, membershipRole: 'owner' };
const view: Actor = { userId: admin.userId, agencyId: A, membershipRole: 'owner', via: 'platform', viewerId: admin.userId };
const memberView: Actor = { ...view, userId: U, membershipRole: 'agent' };

/** Counts statements; every execute/select answers with `rows`. Records insert values. */
function countingDb(rows: unknown[]) {
  let statements = 0;
  const inserted: unknown[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'insert', 'returning']) chain[m] = () => chain;
  chain.values = (v: unknown) => {
    inserted.push(v);
    return chain;
  };
  const terminal = () => {
    statements += 1;
    return Promise.resolve(rows);
  };
  chain.execute = terminal;
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => terminal().then(res, rej);
  return { db: chain as unknown as Db, count: () => statements, inserted };
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

const USER = { id: U, name: 'Ann', email: 'ann@x', phone: null, created_at: '2026-10-01', searches: '3', views: 2, enquiries: 1, saved_searches: 0, shortlist: 0, chats: 1, last_active_at: null, total: 3 };

describe('platform-wide reads refuse anyone but the platform admin', () => {
  const calls: [string, (db: Db, who: Actor) => Promise<unknown>][] = [
    ['listSiteUsers', (db, who) => listSiteUsers(db, who)],
    ['getSiteUser', (db, who) => getSiteUser(db, who, U)],
    ['getSiteUserChat', (db, who) => getSiteUserChat(db, who, U, A)],
    ['siteInsights', (db, who) => siteInsights(db, who)],
    ['siteTrend', (db, who) => siteTrend(db, who)],
    ['platformAttention', (db, who) => platformAttention(db, who)],
  ];
  for (const [name, call] of calls) {
    it(name, async () => {
      for (const who of [owner, view]) {
        const { db, count } = countingDb([USER]);
        expect(await code(call(db, who))).toBe('forbidden');
        expect(count()).toBe(0);
      }
    });
  }

  it('emailActivity runs only under a platform view', async () => {
    for (const who of [owner, admin]) {
      const { db, count } = countingDb([]);
      expect(await code(emailActivity(db, who))).toBe('forbidden');
      expect(count()).toBe(0);
    }
  });
});

describe('fixed statement counts (no N+1)', () => {
  it('users list 1, a user 8, a chat 2, insights 4, trend 1, the home panels 3', async () => {
    const cases: [number, (db: Db) => Promise<unknown>][] = [
      [1, (db) => listSiteUsers(db, admin, { q: 'ann' })],
      [8, (db) => getSiteUser(db, admin, U)],
      [2, (db) => getSiteUserChat(db, admin, U, A)],
      [4, (db) => siteInsights(db, admin, 7)],
      [1, (db) => siteTrend(db, admin, 90)],
      [3, (db) => platformAttention(db, admin)],
    ];
    for (const [expected, run] of cases) {
      const { db, count } = countingDb([USER, USER, USER]);
      await run(db);
      expect(count()).toBe(expected);
    }
  });

  it('email activity: 5 for the agency, 4 for a member (no per-member breakdown)', async () => {
    const a = countingDb([]);
    await emailActivity(a.db, view);
    expect(a.count()).toBe(5);
    const m = countingDb([]);
    const r = await emailActivity(m.db, memberView);
    expect(m.count()).toBe(4);
    expect(r.byMember).toEqual([]);
  });

  it('a user that is not a site user (or a bad id) is not found', async () => {
    expect(await code(getSiteUser(countingDb([]).db, admin, U))).toBe('not_found');
    const { db, count } = countingDb([USER]);
    expect(await code(getSiteUser(db, admin, 'nope'))).toBe('not_found');
    expect(count()).toBe(0);
  });
});

describe('recordSiteActivity', () => {
  it('an anonymous search is counted with its place only — no filters, no id', async () => {
    const { db, inserted } = countingDb([]);
    expect(await recordSiteActivity(db, { userId: null }, { kind: 'search', query: { suburb: 'Bondi', state: 'NSW', channel: 'sale', bedrooms: 3 } })).toBe(true);
    expect(inserted[0]).toEqual({ userId: null, kind: 'search', suburb: 'Bondi', state: 'NSW', channel: 'sale', query: null });
  });

  it('a signed-in search keeps its filters, and drops anything not in the contract', async () => {
    const { db, inserted } = countingDb([]);
    await recordSiteActivity(db, { userId: U }, { kind: 'search', query: { suburb: 'Bondi', bedrooms: 3, agencyId: A, userId: 'forged' } });
    expect(inserted[0]).toMatchObject({ userId: U, suburb: 'Bondi', query: { suburb: 'Bondi', bedrooms: 3 } });
    expect((inserted[0] as { query: Record<string, unknown> }).query).not.toHaveProperty('agencyId');
  });

  it('a listing view is one statement and records only a public listing', async () => {
    const seen = countingDb([{ id: 'row' }]);
    expect(await recordSiteActivity(seen.db, { userId: null }, { kind: 'listing_view', listingId: A })).toBe(true);
    expect(seen.count()).toBe(1);
    const hidden = countingDb([]);
    expect(await recordSiteActivity(hidden.db, { userId: null }, { kind: 'listing_view', listingId: A })).toBe(false);
  });

  it('garbage is ignored without touching the database', async () => {
    for (const body of [null, 'x', { kind: 'listing_view', listingId: 'nope' }, { kind: 'delete' }, { kind: 'search', query: { suburb: 'x'.repeat(500) } }]) {
      const { db, count } = countingDb([]);
      expect(await recordSiteActivity(db, { userId: null }, body)).toBe(false);
      expect(count()).toBe(0);
    }
  });
});
