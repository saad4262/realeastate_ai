import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { can, PLATFORM_READ, type Action, type Actor, type MembershipRole } from '../permissions';
import {
  getAgencyProfile,
  listAgencies,
  listAgencyPeople,
  listAgencyViewLog,
  listAllPeople,
  loadPlatformAdmin,
  logPlatformView,
  platformTotals,
  platformViewActor,
} from './admin';
import {
  getPlatformAssistantChat,
  getPlatformTeamThread,
  listPlatformAssistantChats,
  listPlatformTeamThreads,
} from './private-reads';

/**
 * The admin console (ADR 0049). What has to hold:
 *  - only a platform admin opens it, and the admin themself reaches no agency's data;
 *  - a view actor reads, and NOTHING else — every non-read action refused, whatever role it carries;
 *  - a view of agency A reaches nothing of agency B;
 *  - the readers that exist only for the console refuse an ordinary owner;
 *  - every read is one statement (no N+1).
 */

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const ADMIN_ID = '99999999-9999-9999-9999-999999999999';
const MEMBER_ID = '33333333-3333-3333-3333-333333333333';

function allActions(): Action[] {
  // CRLF on a Windows checkout: the block ends at a blank line either way.
  const src = readFileSync(join(__dirname, '..', 'permissions.ts'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('export type Action =');
  const block = src.slice(start, src.indexOf('\n\nexport', start));
  return [...new Set([...block.matchAll(/\|\s*'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1] as Action))];
}

const ROLE_SET: Record<MembershipRole, true> = { owner: true, admin: true, agent: true, assistant: true, property_manager: true, read_only: true };
const ROLES = Object.keys(ROLE_SET) as MembershipRole[];

const admin: Actor = { userId: ADMIN_ID, platformAdmin: true };
const view = (role: MembershipRole, userId = ADMIN_ID): Actor => ({
  userId,
  agencyId: A,
  membershipRole: role,
  listingAgentOf: ['a-listing'],
  via: 'platform',
  viewerId: ADMIN_ID,
});

/** A resource of agency `agencyId` rigged so that every ownership rule would say "yours". */
function tempting(action: Action, actor: Actor, agencyId: string) {
  return {
    type: action.split(':')[0]!,
    id: 'thing',
    agencyId,
    ownerId: actor.userId,
    listingId: 'a-listing',
    leadAssigneeIds: [actor.userId],
    listingAgentIds: [actor.userId],
    createdBy: actor.userId,
    participantIds: [actor.userId],
    integrationOwnerType: 'user' as const,
    audience: 'agency' as const,
    membersMayUseAgencyGmail: true,
  };
}

describe('can() — the platform admin and the read-only view (ADR 0049)', () => {
  const actions = allActions();

  it('found the whole action list, platform:read included (guards the parser)', () => {
    expect(actions.length).toBeGreaterThan(50);
    expect(actions).toContain('platform:read');
  });

  it('every action in PLATFORM_READ is a read', () => {
    // A write sneaking into the allowlist is the one way this design fails. Names are the contract:
    // each must be a read verb. Adding one that is not means arguing it here, in review.
    for (const a of PLATFORM_READ) expect(a, a).toMatch(/:(read|read_all|read_offer|read_own|read_private|read_agency)$/);
  });

  for (const role of ROLES) {
    it(`a view carrying the ${role} role is refused every action outside PLATFORM_READ`, () => {
      for (const userId of [ADMIN_ID, MEMBER_ID]) {
        const actor = view(role, userId);
        const allowed = actions
          .filter((a) => !PLATFORM_READ.has(a))
          .filter((a) => can(actor, a, tempting(a, actor, A)));
        expect(allowed, `${role} view as ${userId}`).toEqual([]);
      }
    });

    it(`a view of agency A carrying the ${role} role is refused every agency action on agency B`, () => {
      const actor = view(role, MEMBER_ID);
      const personal: Action[] = ['mail:read_own', 'meeting:read_own'];
      const allowed = actions
        .filter((a) => !personal.includes(a))
        .filter((a) => can(actor, a, tempting(a, actor, B)));
      expect(allowed).toEqual([]);
    });
  }

  it("the owner's view still reads what an owner reads", () => {
    const actor = view('owner');
    for (const a of ['lead:read_all', 'contact:read_all', 'appointment:read_all', 'note:read_private', 'listing:read', 'mail:read'] as Action[]) {
      expect(can(actor, a, { type: a.split(':')[0]!, agencyId: A }), a).toBe(true);
    }
  });

  it('the platform admin themself reaches no agency data — only platform:read and platform:manage', () => {
    const allowed = actions.filter((a) => can(admin, a, tempting(a, admin, A)));
    // schedule:create / chat / own-mail rules are a person's own things; the admin is a person.
    const personal = ['schedule:create', 'schedule:read', 'schedule:manage', 'chat:read', 'chat:write', 'mail:read_own', 'meeting:read_own'];
    expect(allowed.filter((a) => !personal.includes(a))).toEqual(['platform:read', 'platform:manage']);
  });

  it('platform:read and platform:manage are refused to an owner, to a member with no agency, and to a view', () => {
    for (const a of ['platform:read', 'platform:manage'] as Action[]) {
      expect(can({ userId: 'u', agencyId: A, membershipRole: 'owner' }, a, { type: 'platform' }), a).toBe(false);
      expect(can({ userId: 'u' }, a, { type: 'platform' }), a).toBe(false);
      expect(can({ ...view('owner'), platformAdmin: true }, a, { type: 'platform' }), a).toBe(false);
    }
  });

  it('a view cannot open either console', () => {
    expect(can(view('owner'), 'console:agency', { type: 'console', agencyId: A })).toBe(false);
    expect(can(view('agent', MEMBER_ID), 'console:agent', { type: 'console', agencyId: A })).toBe(false);
  });
});

/** A Drizzle fake that counts statements and returns `rows` for each. */
function countingDb(rows: unknown[]) {
  let queries = 0;
  const inserted: unknown[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'groupBy', 'limit', 'offset', 'insert']) {
    chain[m] = () => chain;
  }
  const terminal = () => {
    queries += 1;
    return Promise.resolve(rows);
  };
  chain.values = (v: unknown) => {
    inserted.push(v);
    return chain;
  };
  chain.execute = terminal;
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => terminal().then(res, rej);
  return { db: chain as unknown as Db, count: () => queries, inserted };
}

const OWNER: Actor = { userId: 'u-1', agencyId: A, membershipRole: 'owner' };

const AGENCY_ROW = {
  id: A, name: 'Harbour', slug: 'harbour', status: 'active', plan: 'trial', timeZone: 'Australia/Sydney', createdAt: new Date(),
  members: '3', liveListings: 2, leads30d: 1, leadsTotal: 5, contacts: 9, upcomingMeetings: 1, owner: null, total: '3',
  abn: null, logoUrl: null, owners: [],
};
const PERSON_ROW = {
  userId: MEMBER_ID, name: 'Ann', email: 'ann@x', phone: null, role: 'agent', status: 'active', joinedAt: null,
  agencyId: A, agencyName: 'Harbour', openLeads: '2', listings: 1, contacts: 0, upcomingMeetings: 0, lastAssistantAt: null, total: 3,
};

describe('platform reads — who may call them', () => {
  const calls: [string, (db: Db, who: Actor) => Promise<unknown>][] = [
    ['platformTotals', (db, who) => platformTotals(db, who)],
    ['listAgencies', (db, who) => listAgencies(db, who)],
    ['getAgencyProfile', (db, who) => getAgencyProfile(db, who, A)],
    ['listAgencyPeople', (db, who) => listAgencyPeople(db, who, A)],
    ['listAllPeople', (db, who) => listAllPeople(db, who)],
    ['platformViewActor', (db, who) => platformViewActor(db, who, { agencyId: A })],
    ['listAgencyViewLog', (db, who) => listAgencyViewLog(db, who, A)],
  ];
  for (const [name, call] of calls) {
    it(`${name} refuses an agency owner and a view, and asks the database nothing`, async () => {
      for (const who of [OWNER, view('owner')]) {
        const { db, count } = countingDb([AGENCY_ROW]);
        await expect(call(db, who)).rejects.toMatchObject({ code: 'forbidden' });
        expect(count()).toBe(0);
      }
    });
  }

  const privateCalls: [string, (db: Db, who: Actor) => Promise<unknown>][] = [
    ['listPlatformTeamThreads', (db, who) => listPlatformTeamThreads(db, who)],
    ['getPlatformTeamThread', (db, who) => getPlatformTeamThread(db, who, A)],
    ['listPlatformAssistantChats', (db, who) => listPlatformAssistantChats(db, who)],
    ['getPlatformAssistantChat', (db, who) => getPlatformAssistantChat(db, who, A)],
  ];
  for (const [name, call] of privateCalls) {
    it(`${name} refuses an agency owner and the admin themself`, async () => {
      for (const who of [OWNER, admin]) {
        const { db, count } = countingDb([]);
        await expect(call(db, who)).rejects.toMatchObject({ code: 'forbidden' });
        expect(count()).toBe(0);
      }
    });
  }
});

describe('platform reads — one statement each (no N+1)', () => {
  it('a page of agencies is one statement, counts and total included', async () => {
    const { db, count } = countingDb([AGENCY_ROW, AGENCY_ROW, AGENCY_ROW]);
    const page = await listAgencies(db, admin, { q: 'har', status: 'active' });
    expect(count()).toBe(1);
    expect(page.total).toBe(3);
    expect(page.rows[0]!.members).toBe(3);
  });

  it('the totals, a profile, the people lists and the log are one statement each', async () => {
    for (const run of [
      (db: Db) => platformTotals(db, admin),
      (db: Db) => getAgencyProfile(db, admin, A),
      (db: Db) => listAgencyPeople(db, admin, A),
      (db: Db) => listAllPeople(db, admin, { q: 'ann' }),
      (db: Db) => listAgencyViewLog(db, admin, A),
    ]) {
      const { db, count } = countingDb([AGENCY_ROW, PERSON_ROW, PERSON_ROW]);
      await run(db);
      expect(count()).toBe(1);
    }
  });

  it('the team conversation and assistant chat lists are one statement each', async () => {
    const row = { id: A, subject: 's', title: 't', surface: 'agent', turnCount: 2, people: ['a'], lastText: 'hi', messages: 2, lastMessageAt: new Date(), lastTurnAt: new Date() };
    for (const run of [
      (db: Db) => listPlatformTeamThreads(db, view('owner')),
      (db: Db) => listPlatformTeamThreads(db, view('agent', MEMBER_ID)),
      (db: Db) => listPlatformAssistantChats(db, view('agent', MEMBER_ID)),
    ]) {
      const { db, count } = countingDb([row, row, row]);
      await run(db);
      expect(count()).toBe(1);
    }
  });

  it("people counts arrive as numbers, not Postgres's strings", async () => {
    const { db } = countingDb([PERSON_ROW]);
    const [p] = await listAgencyPeople(db, admin, A);
    expect(p!.openLeads).toBe(2);
  });
});

describe('platformViewActor', () => {
  it("the agency's view is its owner's, marked platform, with the admin as viewer", async () => {
    const { db, count } = countingDb([{ agencyId: A, agencyName: 'Harbour', timeZone: 'Australia/Sydney', member: null }]);
    const v = await platformViewActor(db, admin, { agencyId: A });
    expect(count()).toBe(1);
    expect(v.actor).toEqual({ userId: ADMIN_ID, agencyId: A, membershipRole: 'owner', via: 'platform', viewerId: ADMIN_ID });
    expect(v.subject).toBeNull();
  });

  it("a member's view carries their own role and listings", async () => {
    const member = { userId: MEMBER_ID, name: 'Ann', email: 'ann@x', role: 'agent', status: 'active', listings: ['l-1'] };
    const { db } = countingDb([{ agencyId: A, agencyName: 'Harbour', timeZone: 'Australia/Sydney', member }]);
    const v = await platformViewActor(db, admin, { agencyId: A, userId: MEMBER_ID });
    expect(v.actor).toMatchObject({ userId: MEMBER_ID, agencyId: A, membershipRole: 'agent', listingAgentOf: ['l-1'], via: 'platform', viewerId: ADMIN_ID });
    expect(v.subject?.name).toBe('Ann');
  });

  it('someone who is not a member of that agency is not found', async () => {
    const { db } = countingDb([{ agencyId: A, agencyName: 'Harbour', timeZone: 'Australia/Sydney', member: null }]);
    await expect(platformViewActor(db, admin, { agencyId: A, userId: MEMBER_ID })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('an agency that does not exist, or a malformed id, is not found', async () => {
    const { db, count } = countingDb([]);
    await expect(platformViewActor(db, admin, { agencyId: A })).rejects.toMatchObject({ code: 'not_found' });
    await expect(platformViewActor(db, admin, { agencyId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    expect(count()).toBe(1);
  });
});

describe('the view log', () => {
  it("a view's page is logged against the real admin, the agency and the member", async () => {
    const { db, count, inserted } = countingDb([]);
    await logPlatformView(db, view('agent', MEMBER_ID), { area: 'inbox', refId: A });
    expect(count()).toBe(1);
    expect(inserted[0]).toEqual({ adminUserId: ADMIN_ID, agencyId: A, subjectUserId: MEMBER_ID, area: 'inbox', refId: A });
  });

  it("the agency's own view names no member; a platform page names no agency", async () => {
    const { db, inserted } = countingDb([]);
    await logPlatformView(db, view('owner'), { area: 'leads' });
    await logPlatformView(db, admin, { area: 'agencies', refId: 'not-a-uuid' });
    expect(inserted).toEqual([
      { adminUserId: ADMIN_ID, agencyId: A, subjectUserId: null, area: 'leads', refId: null },
      { adminUserId: ADMIN_ID, agencyId: null, subjectUserId: null, area: 'agencies', refId: null },
    ]);
  });

  it('an owner cannot write to it', async () => {
    const { db, count } = countingDb([]);
    await expect(logPlatformView(db, OWNER, { area: 'leads' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(count()).toBe(0);
  });
});

describe('loadPlatformAdmin', () => {
  it('a row makes a platform admin with no agency; no row, or a bad id, makes nobody', async () => {
    expect(await loadPlatformAdmin(countingDb([{ userId: ADMIN_ID }]).db, ADMIN_ID)).toEqual({ userId: ADMIN_ID, platformAdmin: true });
    expect(await loadPlatformAdmin(countingDb([]).db, ADMIN_ID)).toBeNull();
    const { db, count } = countingDb([{ userId: ADMIN_ID }]);
    expect(await loadPlatformAdmin(db, 'x')).toBeNull();
    expect(count()).toBe(0);
  });
});
