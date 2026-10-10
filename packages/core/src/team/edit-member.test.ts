import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import type { Actor } from '../permissions';
import { changedFields, editTeamMember, teamMemberPatchSchema, TeamEditError, withdrawInvite, type TeamMemberDetails } from './edit-member';

const agencyA = '11111111-1111-1111-1111-111111111111';
const agencyB = '22222222-2222-2222-2222-222222222222';
const ownerA: Actor = { userId: '33333333-3333-3333-3333-333333333333', agencyId: agencyA, membershipRole: 'owner' };
const adminA: Actor = { userId: '77777777-7777-7777-7777-777777777777', agencyId: agencyA, membershipRole: 'admin' };
const agentA: Actor = { userId: '44444444-4444-4444-4444-444444444444', agencyId: agencyA, membershipRole: 'agent' };
const ownerB: Actor = { userId: '55555555-5555-5555-5555-555555555555', agencyId: agencyB, membershipRole: 'owner' };
const memberId = '88888888-8888-8888-8888-888888888888';
const inviteId = '99999999-9999-9999-9999-999999999999';

/** Chained drizzle stand-in: `limit` and `returning` are the terminals; records what was written. */
function fakeDb(results: unknown[][]) {
  let i = 0;
  const writes: { table: unknown; set: unknown }[] = [];
  let pending: { table: unknown } | null = null;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'where']) chain[m] = () => chain;
  chain.update = (table: unknown) => {
    pending = { table };
    return chain;
  };
  chain.set = (set: unknown) => {
    writes.push({ table: pending?.table, set });
    return chain;
  };
  chain.limit = () => Promise.resolve(results[i++] ?? []);
  chain.returning = () => Promise.resolve(results[i++] ?? []);
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res);
  chain.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(chain);
  return { db: chain as unknown as Db, writes };
}

const memberRow = {
  role: 'agent',
  status: 'active',
  email: 'ali@agency.com.au',
  name: 'Ali Asad',
  phone: '0418 920 441',
  profileId: 'p1',
  firstName: 'Ali',
  lastName: 'Asad',
  displayName: 'Ali Asad',
  licenceNumber: '23983290932',
  licenceExpiry: new Date('2027-06-30T00:00:00.000Z'),
  territorySuburbs: ['Berwick'],
  operationalRole: 'senior',
};

const inviteDraft = {
  firstName: 'Zohaib',
  lastName: 'Anwar',
  displayName: 'Zohaib Anwar',
  email: 'zohaib@agency.com.au',
  phone: '0418 920 442',
  licenceNumber: '3920320932',
  territorySuburbs: ['Berwick'],
  operationalRole: 'senior',
  commissionTier: 't1',
};

async function refusal(p: Promise<unknown>): Promise<TeamEditError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TeamEditError);
  return err as TeamEditError;
}

describe('teamMemberPatchSchema', () => {
  it('needs at least one field and rejects anything else', () => {
    expect(teamMemberPatchSchema.safeParse({}).success).toBe(false);
    expect(teamMemberPatchSchema.safeParse({ commissionSplitAgent: 90 }).success).toBe(false);
    expect(teamMemberPatchSchema.safeParse({ licenceNumber: '123' }).success).toBe(true);
  });

  it('holds the wizard’s rules: phone digits, date shape, 1–20 suburbs', () => {
    expect(teamMemberPatchSchema.safeParse({ phone: '12' }).success).toBe(false);
    expect(teamMemberPatchSchema.safeParse({ licenceExpiry: '30/06/2027' }).success).toBe(false);
    expect(teamMemberPatchSchema.safeParse({ licenceExpiry: null }).success).toBe(true);
    expect(teamMemberPatchSchema.safeParse({ territorySuburbs: [] }).success).toBe(false);
  });
});

describe('changedFields', () => {
  const now: TeamMemberDetails = {
    firstName: 'Ali', lastName: 'Asad', displayName: 'Ali Asad', email: 'ali@x.com', phone: null,
    licenceNumber: '1', licenceExpiry: null, territorySuburbs: ['Berwick'], operationalRole: 'senior',
  };
  it('drops values that are already so, compares suburbs as lists and emails without case', () => {
    expect(changedFields(now, { licenceNumber: '1', territorySuburbs: ['Berwick'], email: 'ALI@x.com' })).toEqual([]);
    expect(changedFields(now, { licenceNumber: '2', territorySuburbs: ['Berwick', 'Pakenham'] })).toEqual(['licenceNumber', 'territorySuburbs']);
  });
});

describe('editTeamMember — who may', () => {
  it('refuses an agent before reading anything', async () => {
    const { db, writes } = fakeDb([[memberRow]]);
    const err = await refusal(editTeamMember(db, agentA, { kind: 'member', userId: memberId }, { licenceNumber: '2' }));
    expect(err.code).toBe('forbidden');
    expect(writes).toEqual([]);
  });

  it('another agency’s owner finds nothing (the lookup is scoped to their own agency)', async () => {
    const { db, writes } = fakeDb([[]]);
    const err = await refusal(editTeamMember(db, ownerB, { kind: 'member', userId: memberId }, { licenceNumber: '2' }));
    expect(err.code).toBe('not_found');
    expect(writes).toEqual([]);
  });

  it('an admin changes the licence number and territory', async () => {
    const { db, writes } = fakeDb([[memberRow]]);
    const out = await editTeamMember(db, adminA, { kind: 'member', userId: memberId }, { licenceNumber: '2', territorySuburbs: ['Pakenham'] });
    expect(out.changed).toEqual(['licenceNumber', 'territorySuburbs']);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.set).toMatchObject({ licenceNumber: '2', territorySuburbs: ['Pakenham'] });
  });

  it('a role change also sets membership.role, as the wizard does', async () => {
    const { db, writes } = fakeDb([[memberRow]]);
    await editTeamMember(db, ownerA, { kind: 'member', userId: memberId }, { operationalRole: 'pm' });
    expect(writes.map((w) => w.set)).toEqual([
      expect.objectContaining({ operationalRole: 'pm' }),
      expect.objectContaining({ role: 'property_manager' }),
    ]);
  });
});

describe('editTeamMember — what may not change', () => {
  it('an active member’s email is their sign-in: refused, nothing written', async () => {
    const { db, writes } = fakeDb([[memberRow]]);
    const err = await refusal(editTeamMember(db, ownerA, { kind: 'member', userId: memberId }, { email: 'me@admin.com' }));
    expect(err.code).toBe('invalid');
    expect(writes).toEqual([]);
  });

  it('never your own role', async () => {
    const { db } = fakeDb([[{ ...memberRow, role: 'admin', operationalRole: 'principal' }]]);
    const err = await refusal(editTeamMember(db, adminA, { kind: 'member', userId: adminA.userId }, { operationalRole: 'senior' }));
    expect(err.code).toBe('forbidden');
  });

  it('never an owner’s role', async () => {
    const { db } = fakeDb([[{ ...memberRow, role: 'owner' }]]);
    const err = await refusal(editTeamMember(db, adminA, { kind: 'member', userId: memberId }, { operationalRole: 'cadet' }));
    expect(err.code).toBe('forbidden');
  });

  it('a field that changed after the card was made: refused', async () => {
    const { db, writes } = fakeDb([[memberRow]]);
    const err = await refusal(
      editTeamMember(db, ownerA, { kind: 'member', userId: memberId }, { licenceNumber: '2' }, { expected: { licenceNumber: '0000' } }),
    );
    expect(err.code).toBe('conflict');
    expect(writes).toEqual([]);
  });
});

describe('editTeamMember — a pending invite', () => {
  it('a new email rotates the token: a new link, the old one dead', async () => {
    const { db, writes } = fakeDb([
      [{ email: inviteDraft.email, status: 'pending', draft: inviteDraft }], // loadTeamTarget
      [], // nobody in the agency has that email
      [], // no other waiting invite for it
      [{ draft: inviteDraft }], // the draft, to merge into
      [{ id: inviteId }], // the guarded update
    ]);
    const out = await editTeamMember(db, ownerA, { kind: 'invite', inviteId }, { email: 'Zohaib.Anwar@Agency.com.au' });
    expect(out.changed).toEqual(['email']);
    expect(out.claim?.email).toBe('zohaib.anwar@agency.com.au');
    expect(out.claim?.claimPath).toMatch(/^\/signup\?invite=[0-9a-f]{48}&email=zohaib\.anwar%40agency\.com\.au$/);
    expect(writes[0]!.set).toMatchObject({ email: 'zohaib.anwar@agency.com.au', token: expect.stringMatching(/^[0-9a-f]{48}$/) });
  });

  it('an email a member already has: refused', async () => {
    const { db, writes } = fakeDb([[{ email: inviteDraft.email, status: 'pending', draft: inviteDraft }], [{ id: 'm1' }]]);
    const err = await refusal(editTeamMember(db, ownerA, { kind: 'invite', inviteId }, { email: 'ali@agency.com.au' }));
    expect(err.code).toBe('conflict');
    expect(writes).toEqual([]);
  });

  it('a licence fix keeps the link', async () => {
    const { db, writes } = fakeDb([
      [{ email: inviteDraft.email, status: 'pending', draft: inviteDraft }],
      [{ draft: inviteDraft }],
      [{ id: inviteId }],
    ]);
    const out = await editTeamMember(db, ownerA, { kind: 'invite', inviteId }, { licenceNumber: '111' });
    expect(out.claim).toBeNull();
    expect(writes[0]!.set).not.toHaveProperty('token');
  });
});

describe('withdrawInvite', () => {
  it('an agent may not', async () => {
    const { db } = fakeDb([]);
    expect((await refusal(withdrawInvite(db, agentA, inviteId))).code).toBe('forbidden');
  });
  it('one already claimed or withdrawn: not found', async () => {
    const { db } = fakeDb([[]]);
    expect((await refusal(withdrawInvite(db, ownerA, inviteId))).code).toBe('not_found');
  });
  it('a pending one is revoked', async () => {
    const { db, writes } = fakeDb([[{ email: 'z@x.com' }]]);
    await withdrawInvite(db, ownerA, inviteId);
    expect(writes[0]!.set).toMatchObject({ status: 'revoked' });
  });
});
