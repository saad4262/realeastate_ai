import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import type { EmailMessage } from '../email/transport';
import { createPlatformEmail, deliverPlatformEmails, describeAudience, listPlatformEmails, previewPlatformEmail } from './emails';
import { blockSiteUser, isUserBlocked, unblockSiteUser, type AuthBan } from './manage';
import { platformPeople, touchLastSeen } from './presence';

/**
 * ADR 0052: online, email from the platform, blocking a site user.
 *  - only a platform admin (never an owner, never a view) reads or acts, asking nothing first;
 *  - fixed statement counts;
 *  - email: the audience is checked, empty audiences refused, delivery records each result and
 *    never sends without a mailer;
 *  - block: agency members are refused (they have their own block), the ban runs after the
 *    transaction, and a failed ban leaves the block standing and says so.
 */

const A = '11111111-1111-1111-1111-111111111111';
const U = '33333333-3333-3333-3333-333333333333';
const admin: Actor = { userId: '99999999-9999-9999-9999-999999999999', platformAdmin: true };
const owner: Actor = { userId: 'u', agencyId: A, membershipRole: 'owner' };
const view: Actor = { ...owner, userId: admin.userId, via: 'platform', viewerId: admin.userId };

/** Answers each statement with the next queued result (or `fallback`); counts them and records SQL text. */
function scriptedDb(results: unknown[][] = [], fallback: unknown[] = []) {
  let i = 0;
  let statements = 0;
  const texts: string[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'insert', 'values', 'returning', 'update', 'set']) chain[m] = () => chain;
  const next = () => {
    statements += 1;
    return Promise.resolve(results[i++] ?? fallback);
  };
  chain.execute = (q: { queryChunks?: unknown[] }) => {
    texts.push(JSON.stringify(q?.queryChunks ?? ''));
    return next();
  };
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => next().then(res, rej);
  chain.transaction = async (fn: (tx: unknown) => unknown) => fn(chain);
  return { db: chain as unknown as Db, count: () => statements, texts };
}

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

describe('who may', () => {
  const calls: [string, (db: Db, who: Actor) => Promise<unknown>][] = [
    ['platformPeople', (db, who) => platformPeople(db, who)],
    ['previewPlatformEmail', (db, who) => previewPlatformEmail(db, who, { kind: 'all_users' })],
    ['createPlatformEmail', (db, who) => createPlatformEmail(db, who, { kind: 'all_users' }, { subject: 'Hello there', body: 'A service message.' })],
    ['listPlatformEmails', (db, who) => listPlatformEmails(db, who)],
    ['describeAudience', (db, who) => describeAudience(db, who, { kind: 'user', userId: U })],
    ['blockSiteUser', (db, who) => blockSiteUser(db, who, U, 'spam enquiries')],
    ['unblockSiteUser', (db, who) => unblockSiteUser(db, who, U)],
  ];
  for (const [name, call] of calls) {
    it(`${name} refuses an agency owner and a platform view, asking nothing`, async () => {
      for (const who of [owner, view]) {
        const { db, count } = scriptedDb();
        expect(await code(call(db, who))).toBe('forbidden');
        expect(count()).toBe(0);
      }
    });
  }
});

describe('presence', () => {
  it('touching last seen is one statement, and a bad id is none', async () => {
    const a = scriptedDb();
    await touchLastSeen(a.db, U);
    expect(a.count()).toBe(1);
    expect(a.texts[0]).toContain("interval '60 seconds'");
    const b = scriptedDb();
    await touchLastSeen(b.db, 'x');
    expect(b.count()).toBe(0);
  });

  it('the dashboard people are five statements with numbers, not strings', async () => {
    const { db, count } = scriptedDb([[{ agencies: '4', agencies_online: 1, agents: 15, users: '6', users_online: 2 }]]);
    const p = await platformPeople(db, admin);
    expect(count()).toBe(5);
    expect(p.agencies).toEqual({ total: 4, online: 1, suspended: 0 });
    expect(p.users.online).toBe(2);
  });
});

describe('email from the platform', () => {
  it('a bad id or an unknown audience is refused before the database', async () => {
    for (const a of [{ kind: 'user', userId: 'nope' }, { kind: 'agency', agencyId: 'x' }, { kind: 'everyone' }] as never[]) {
      const { db, count } = scriptedDb();
      expect(await code(previewPlatformEmail(db, admin, a))).toBe('invalid');
      expect(count()).toBe(0);
    }
  });

  it('a subject and a message are required', async () => {
    expect(await code(createPlatformEmail(scriptedDb().db, admin, { kind: 'all_users' }, { subject: 'x', body: 'A service message.' }))).toBe('invalid');
    expect(await code(createPlatformEmail(scriptedDb().db, admin, { kind: 'all_users' }, { subject: 'Hello there', body: 'short' }))).toBe('invalid');
  });

  it('recording freezes the recipients in three statements; an empty audience is refused', async () => {
    const ok = scriptedDb([[{ id: 'e1' }], [{ id: 'r1' }, { id: 'r2' }], []]);
    expect(await createPlatformEmail(ok.db, admin, { kind: 'agency', agencyId: A }, { subject: 'Hello there', body: 'A service message.' })).toEqual({ emailId: 'e1', recipients: 2 });
    expect(ok.count()).toBe(3);
    const empty = scriptedDb([[{ id: 'e1' }], []]);
    expect(await code(createPlatformEmail(empty.db, admin, { kind: 'agency', agencyId: A }, { subject: 'Hello there', body: 'A service message.' }))).toBe('invalid');
  });

  it('delivery sends each claimed recipient once, records sent and failed, with name, footer and an idempotency key', async () => {
    const sent: EmailMessage[] = [];
    const transport = {
      send: async (m: EmailMessage) => {
        sent.push(m);
        return m.to.email.startsWith('bad') ? { ok: false as const, error: 'rejected', retryable: false } : { ok: true as const, id: 'p1' };
      },
    };
    const sender = { from: { email: 'alerts@example.com', name: 'LocalAgentHub' }, postalAddress: '1 Test St, Sydney NSW' };
    const claimed = [
      { id: 'r1', email: 'ann@x.test', name: 'Ann', subject: 'Hello', body: 'Line one.\n\nLine <two>.', email_id: 'e1' },
      { id: 'r2', email: 'bad@x.test', name: null, subject: 'Hello', body: 'Body.', email_id: 'e1' },
    ];
    const { db, count } = scriptedDb([claimed]);
    expect(await deliverPlatformEmails(db, { sender, transport }, { emailId: 'e1' })).toEqual({ sent: 1, failed: 1 });
    expect(count()).toBe(3); // the claim, then one result each
    expect(sent[0]).toMatchObject({ kind: 'transactional', to: { email: 'ann@x.test', name: 'Ann' }, idempotencyKey: 'platform-email-r1' });
    expect(sent[0]!.text).toContain('Hi Ann,');
    expect(sent[0]!.text).toContain('1 Test St, Sydney NSW');
    expect(sent[0]!.html).toContain('Line &lt;two&gt;.');
  });

  it('without a mailer nothing is claimed or sent', async () => {
    const { db, count } = scriptedDb();
    expect(await deliverPlatformEmails(db, null)).toEqual({ sent: 0, failed: 0 });
    expect(count()).toBe(0);
  });
});

describe('blocking a site user', () => {
  const fakeBan = (fail = false) => {
    const calls: [string, boolean][] = [];
    const auth: AuthBan = {
      setBanned: async (id, banned) => {
        calls.push([id, banned]);
        if (fail) throw new Error('auth down');
      },
    };
    return { auth, calls };
  };

  it('blocks: the flag and the record, then the ban', async () => {
    const { auth, calls } = fakeBan();
    const { db, count } = scriptedDb([[{ id: U, blocked_at: null, member: false, admin: false }], [], []]);
    expect(await blockSiteUser(db, admin, U, 'spam enquiries', { auth })).toEqual({ signInChanged: true });
    expect(count()).toBe(3);
    expect(calls).toEqual([[U, true]]);
  });

  it('a failed ban leaves the block standing and says so', async () => {
    const { auth } = fakeBan(true);
    const { db } = scriptedDb([[{ id: U, blocked_at: null, member: false, admin: false }], [], []]);
    expect(await blockSiteUser(db, admin, U, 'spam enquiries', { auth })).toEqual({ signInChanged: false });
  });

  it('an agency member or a platform admin is refused (they have their own block); so is a second block', async () => {
    for (const row of [{ member: true, admin: false }, { member: false, admin: true }]) {
      const { auth, calls } = fakeBan();
      const { db } = scriptedDb([[{ id: U, blocked_at: null, ...row }]]);
      expect(await code(blockSiteUser(db, admin, U, 'spam enquiries', { auth }))).toBe('invalid');
      expect(calls).toEqual([]);
    }
    const twice = scriptedDb([[{ id: U, blocked_at: '2026-10-21', member: false, admin: false }]]);
    expect(await code(blockSiteUser(twice.db, admin, U, 'spam enquiries'))).toBe('invalid');
  });

  it('unblocking lifts the flag and the ban', async () => {
    const { auth, calls } = fakeBan();
    const { db } = scriptedDb([[{ id: U, blocked_at: '2026-10-21', member: false, admin: false }], [], []]);
    expect(await unblockSiteUser(db, admin, U, { auth })).toEqual({ signInChanged: true });
    expect(calls).toEqual([[U, false]]);
  });

  it('isUserBlocked reads one row', async () => {
    expect(await isUserBlocked(scriptedDb([[{ blocked: true }]]).db, U)).toBe(true);
    expect(await isUserBlocked(scriptedDb([[{ blocked: false }]]).db, U)).toBe(false);
    const { db, count } = scriptedDb();
    expect(await isUserBlocked(db, 'x')).toBe(false);
    expect(count()).toBe(0);
  });
});
