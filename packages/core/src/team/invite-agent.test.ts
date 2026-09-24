import { describe, expect, it } from 'vitest';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import {
  claimAgentInvite,
  formatRemaining,
  inviteAgent,
  inviteTtlMinutes,
  peekAgentInvite,
} from './invite-agent';
import {
  draftFieldErrors,
  isInviteAgentError,
  membershipRoleFromOperational,
  inviteAgentDraftSchema,
  phoneSchema,
  slugifyAgentName,
  toInviteAgentError,
} from './invite-schema';

const agencyA = '11111111-1111-1111-1111-111111111111';
const agencyB = '22222222-2222-2222-2222-222222222222';
const ownerId = '33333333-3333-3333-3333-333333333333';

const ownerA: Actor = {
  userId: ownerId,
  agencyId: agencyA,
  membershipRole: 'owner',
};

const validDraft = {
  firstName: 'Daniel',
  lastName: 'Vance',
  displayName: 'Daniel Vance',
  email: 'd.vance@agency.com.au',
  phone: '+61 418 920 441',
  licenceNumber: '2049182',
  territorySuburbs: ['Bondi Beach', 'Tamarama'],
  operationalRole: 'senior' as const,
  commissionTier: 't1' as const,
};

/**
 * Minimal drizzle stand-in: every chained call returns itself, and each
 * terminal .limit() hands back the next queued result. Enough for the guards,
 * which all throw before the first insert.
 */
function fakeDb(selectResults: unknown[][]): Db {
  let i = 0;
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'from', 'innerJoin', 'where', 'update', 'set']) {
    chain[method] = () => chain;
  }
  chain.limit = () => Promise.resolve(selectResults[i++] ?? []);
  return chain as unknown as Db;
}

describe('invite agent authz + contract', () => {
  it('allows Agency A admin team:manage and denies Agency B resource', () => {
    const adminA: Actor = {
      userId: 'admin-a',
      agencyId: agencyA,
      membershipRole: 'admin',
    };
    expect(can(adminA, 'team:manage', { type: 'team', agencyId: agencyA })).toBe(
      true,
    );
    expect(can(adminA, 'team:manage', { type: 'team', agencyId: agencyB })).toBe(
      false,
    );
  });

  it('denies agent inviting teammates', () => {
    const agent: Actor = {
      userId: 'agent-a',
      agencyId: agencyA,
      membershipRole: 'agent',
    };
    expect(can(agent, 'team:manage', { type: 'team', agencyId: agencyA })).toBe(
      false,
    );
  });

  it('maps operational presets to membership roles', () => {
    expect(membershipRoleFromOperational('senior')).toBe('agent');
    expect(membershipRoleFromOperational('principal')).toBe('admin');
    expect(membershipRoleFromOperational('pm')).toBe('property_manager');
    expect(membershipRoleFromOperational('cadet')).toBe('assistant');
  });

  it('validates invite draft and builds slug', () => {
    const draft = inviteAgentDraftSchema.parse({
      firstName: 'Daniel',
      lastName: 'Vance',
      displayName: 'Daniel Vance',
      email: 'd.vance@agency.com.au',
      phone: '+61 418 920 441',
      licenceNumber: '2049182',
      territorySuburbs: ['Bondi Beach', 'Tamarama'],
      operationalRole: 'senior',
      commissionTier: 't1',
    });
    expect(draft.email).toContain('@');
    expect(slugifyAgentName(draft.displayName, draft.licenceNumber)).toMatch(
      /daniel-vance-049182/,
    );
  });
});

describe('phone contract', () => {
  it('counts digits, not characters', () => {
    // 8 characters but 7 digits — the old .min(8) on the string let this in
    expect(phoneSchema.safeParse('+61 4189').success).toBe(false);
    expect(phoneSchema.safeParse('0418 920 441').success).toBe(true);
    expect(phoneSchema.safeParse('+61 418 920 441').success).toBe(true);
    expect(phoneSchema.safeParse('(02) 9130 1000').success).toBe(true);
  });

  it('rejects empty, letters and absurd lengths with readable messages', () => {
    const empty = phoneSchema.safeParse('   ');
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues[0]?.message).toBe('Mobile number is required');
    }

    const letters = phoneSchema.safeParse('call me');
    expect(letters.success).toBe(false);

    const tooShort = phoneSchema.safeParse('12345');
    expect(tooShort.success).toBe(false);
    if (!tooShort.success) {
      expect(tooShort.error.issues[0]?.message).toContain('at least 8 digits');
    }

    expect(phoneSchema.safeParse('1234567890123456').success).toBe(false);
  });
});

describe('draft field errors', () => {
  it('is empty for a complete draft', () => {
    expect(draftFieldErrors(validDraft)).toEqual({});
  });

  it('returns one readable message per field', () => {
    const errors = draftFieldErrors({
      ...validDraft,
      email: 'not-an-email',
      phone: '123',
      licenceNumber: '',
      territorySuburbs: [],
    });
    expect(errors.email).toBe('Enter a valid email address');
    expect(errors.phone).toContain('at least 8 digits');
    expect(errors.licenceNumber).toBe('Fair Trading licence number is required');
    expect(errors.territorySuburbs).toBe('Add at least one territory suburb');
  });

  it('turns a raw ZodError into one line instead of a JSON issue array', () => {
    const parsed = inviteAgentDraftSchema.safeParse({ ...validDraft, phone: '12' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const err = toInviteAgentError(parsed.error);
    expect(err.code).toBe('invalid_draft');
    expect(err.field).toBe('phone');
    expect(err.message).not.toContain('too_small');
    expect(err.message).toContain('at least 8 digits');
  });
});

describe('inviteAgent guards', () => {
  it('refuses an agent before touching the database', async () => {
    const agent: Actor = { userId: 'agent-a', agencyId: agencyA, membershipRole: 'agent' };
    await expect(
      inviteAgent(null as unknown as Db, agent, validDraft),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses an admin with no agency', async () => {
    await expect(
      inviteAgent(null as unknown as Db, { userId: ownerId }, validDraft),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('names self-invite by role instead of calling the owner an agent', async () => {
    const db = fakeDb([[{ userId: ownerId, role: 'owner' }]]);
    await expect(
      inviteAgent(db, ownerA, { ...validDraft, email: 'owner@agency.com.au' }),
    ).rejects.toMatchObject({
      code: 'self_invite',
      field: 'email',
      message: 'You cannot invite yourself — you are already the owner of this agency',
    });
  });

  it('says member, not agent, when someone else already belongs', async () => {
    const db = fakeDb([[{ userId: 'someone-else', role: 'agent' }]]);
    await expect(inviteAgent(db, ownerA, validDraft)).rejects.toMatchObject({
      code: 'already_member',
      field: 'email',
      message: 'An account with this email is already a member of your agency',
    });
  });

  it('blocks a second invite while one is still live, and counts it down', async () => {
    const expiresAt = new Date(Date.now() + 3 * 60_000);
    const db = fakeDb([[], [{ id: 'invite-1', expiresAt }]]);
    const err = await inviteAgent(db, ownerA, validDraft).catch((e: unknown) => e);
    expect(isInviteAgentError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'invite_pending', field: 'email' });
    expect((err as Error).message).toContain('expires in 3 minutes');
  });

  it('lets the same email through once no live invite remains', async () => {
    // member lookup empty, pending lookup empty -> the insert is reached
    const db = fakeDb([[], []]);
    const err = await inviteAgent(db, ownerA, validDraft).catch((e: unknown) => e);
    expect(isInviteAgentError(err) && err.code === 'invite_pending').toBe(false);
  });
});

describe('invite lifetime', () => {
  it('defaults to 2 hours and clamps a bad or huge override', () => {
    expect(inviteTtlMinutes({})).toBe(120);
    expect(inviteTtlMinutes({ AGENT_INVITE_TTL_MINUTES: '30' })).toBe(30);
    expect(inviteTtlMinutes({ AGENT_INVITE_TTL_MINUTES: 'soon' })).toBe(120);
    expect(inviteTtlMinutes({ AGENT_INVITE_TTL_MINUTES: '0' })).toBe(120);
    expect(inviteTtlMinutes({ AGENT_INVITE_TTL_MINUTES: '-9' })).toBe(120);
    expect(inviteTtlMinutes({ AGENT_INVITE_TTL_MINUTES: '999999' })).toBe(60 * 24 * 14);
  });

  it('reads as a countdown, not a timestamp', () => {
    const now = Date.UTC(2026, 8, 21, 6, 0, 0);
    expect(formatRemaining(new Date(now + 60_000), now)).toBe('1 minute');
    expect(formatRemaining(new Date(now + 5 * 60_000), now)).toBe('5 minutes');
    expect(formatRemaining(new Date(now + 90 * 60_000), now)).toBe('2 hours');
    expect(formatRemaining(new Date(now + 72 * 3_600_000), now)).toBe('3 days');
    // Already lapsed never reads as a negative or zero
    expect(formatRemaining(new Date(now - 60_000), now)).toBe('1 minute');
  });
});

describe('claiming a lapsed invite', () => {
  const claimer = { userId: 'agent-1', email: 'D.Vance@agency.com.au' };

  it('reports expired rather than looking like no invite at all', async () => {
    const db = fakeDb([
      [
        {
          id: 'invite-1',
          token: 'tok',
          expiresAt: new Date(Date.now() - 60_000),
          status: 'pending',
        },
      ],
    ]);
    await expect(claimAgentInvite(db, { ...claimer, token: 'tok' })).resolves.toEqual({
      claimed: false,
      reason: 'expired',
    });
  });

  it('reports none when the email was never invited', async () => {
    await expect(claimAgentInvite(fakeDb([[]]), claimer)).resolves.toEqual({
      claimed: false,
      reason: 'none',
    });
  });
});


describe('peekAgentInvite', () => {
  const row = (expiresAt: Date, status = 'pending') => [
    {
      email: 'agent@example.com',
      expiresAt,
      status,
      agencyName: 'Bondi Prestige Group',
    },
  ];

  it('describes a live invite so the claim screen can name the agency', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const preview = await peekAgentInvite(fakeDb([row(expiresAt)]), 'tok');

    expect(preview).toEqual({
      email: 'agent@example.com',
      agencyName: 'Bondi Prestige Group',
      expiresAt,
      state: 'live',
    });
  });

  it('reports a lapsed invite as expired rather than hiding it', async () => {
    const preview = await peekAgentInvite(
      fakeDb([row(new Date(Date.now() - 60_000))]),
      'tok',
    );
    expect(preview?.state).toBe('expired');
  });

  it('calls an accepted invite accepted, never expired', async () => {
    // The two screens say opposite things: one sends the agent to sign in,
    // the other tells them to chase a new link they do not need.
    const future = new Date(Date.now() + 60 * 60_000);
    const preview = await peekAgentInvite(fakeDb([row(future, 'accepted')]), 'tok');
    expect(preview?.state).toBe('accepted');
  });

  it('reports a withdrawn invite as revoked', async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    const preview = await peekAgentInvite(fakeDb([row(future, 'revoked')]), 'tok');
    expect(preview?.state).toBe('revoked');
  });

  it('returns null for an unknown or blank token', async () => {
    await expect(peekAgentInvite(fakeDb([[]]), 'nope')).resolves.toBeNull();
    await expect(peekAgentInvite(fakeDb([row(new Date())]), '  ')).resolves.toBeNull();
  });

  it('takes no actor — the token is the only credential the claimer has', () => {
    // Guards the design: the invited agent has no session and no membership
    // yet, so can() cannot gate this read. Anything sensitive must stay out
    // of InvitePreview; claiming is still gated in claimAgentInvite.
    expect(peekAgentInvite.length).toBe(2);
  });
});
