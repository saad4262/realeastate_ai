import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { agentInvite, agentProfile, membership, user, type Db } from '@repo/db';
import { can, type Actor, type MembershipRole } from '../permissions';
import {
  inviteAgentDraftSchema,
  membershipRoleFromOperational,
  operationalRoleSchema,
  phoneSchema,
  type OperationalRole,
} from './invite-schema';
import { inviteTtlMinutes } from './invite-agent';

/**
 * Correct a team member's details, or a pending invite's (ADR 0033). One
 * function for the Agents & Team screen and the assistant's card: it asks
 * `team:manage` itself, so a caller that forgot to cannot skip it.
 *
 * An active member's EMAIL is refused: it is their sign-in, and an admin who
 * set it to an address they control could reset the password and become that
 * agent. A pending invite's email can change — its token is rotated, so the
 * link already sent stops working.
 */

export class TeamEditError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'TeamEditError';
  }
}

/** Who is being changed: a member (by user id) or a pending invite (by invite id). */
export type TeamTarget = { kind: 'member'; userId: string } | { kind: 'invite'; inviteId: string };

export const TEAM_EDIT_FIELDS = [
  'firstName',
  'lastName',
  'displayName',
  'email',
  'phone',
  'licenceNumber',
  'licenceExpiry',
  'territorySuburbs',
  'operationalRole',
] as const;
export type TeamEditField = (typeof TEAM_EDIT_FIELDS)[number];

export const TEAM_FIELD_LABELS: Record<TeamEditField, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  displayName: 'Display name',
  email: 'Email',
  phone: 'Phone',
  licenceNumber: 'Licence number',
  licenceExpiry: 'Licence expiry',
  territorySuburbs: 'Territory',
  operationalRole: 'Role',
};

export const OPERATIONAL_ROLE_LABELS: Record<OperationalRole, string> = {
  senior: 'Senior agent',
  principal: 'Principal (admin)',
  pm: 'Property manager',
  cadet: 'Cadet / assistant',
  custom: 'Custom',
};

const draft = inviteAgentDraftSchema.shape;

/** The edit's contract. Every field optional; at least one. Same rules as the invite wizard. */
export const teamMemberPatchSchema = z
  .object({
    firstName: draft.firstName,
    lastName: draft.lastName,
    displayName: draft.displayName,
    email: draft.email,
    phone: phoneSchema,
    licenceNumber: draft.licenceNumber,
    /** YYYY-MM-DD, or null to clear it. */
    licenceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Licence expiry must be a date as YYYY-MM-DD').nullable(),
    territorySuburbs: draft.territorySuburbs,
    operationalRole: operationalRoleSchema,
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Say which detail to change');
export type TeamMemberPatch = z.infer<typeof teamMemberPatchSchema>;

export type TeamMemberDetails = {
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  email: string;
  phone: string | null;
  licenceNumber: string | null;
  licenceExpiry: string | null;
  territorySuburbs: string[];
  operationalRole: OperationalRole | null;
};

export type LoadedTeamTarget = {
  target: TeamTarget;
  /** The name the directory shows. */
  name: string;
  status: 'active' | 'invited';
  membershipRole: MembershipRole;
  /** A member with no agent_profile row (an owner who never was an agent) has no profile fields. */
  hasProfile: boolean;
  details: TeamMemberDetails;
};

const uuid = z.string().uuid();
const NOT_FOUND = () => new TeamEditError('not_found', 'That team member was not found');

function requireTeam(actor: Actor): string {
  if (!actor.agencyId || !can(actor, 'team:manage', { type: 'team', agencyId: actor.agencyId })) {
    throw new TeamEditError('forbidden', 'Only an owner or admin can change team members');
  }
  return actor.agencyId;
}

function isoDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function asRole(v: string | null): OperationalRole | null {
  const r = operationalRoleSchema.safeParse(v);
  return r.success ? r.data : null;
}

/** The member or invite as it is now, in this actor's agency — or not found. */
export async function loadTeamTarget(db: Db, actor: Actor, target: TeamTarget): Promise<LoadedTeamTarget> {
  const agencyId = requireTeam(actor);
  if (target.kind === 'member') {
    if (!uuid.safeParse(target.userId).success) throw NOT_FOUND();
    const [r] = await db
      .select({
        role: membership.role,
        status: membership.status,
        email: user.email,
        name: user.name,
        phone: user.phone,
        profileId: agentProfile.id,
        firstName: agentProfile.firstName,
        lastName: agentProfile.lastName,
        displayName: agentProfile.displayName,
        licenceNumber: agentProfile.licenceNumber,
        licenceExpiry: agentProfile.licenceExpiry,
        territorySuburbs: agentProfile.territorySuburbs,
        operationalRole: agentProfile.operationalRole,
      })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .leftJoin(agentProfile, eq(agentProfile.userId, membership.userId))
      .where(
        and(
          eq(membership.userId, target.userId),
          eq(membership.agencyId, agencyId),
          inArray(membership.status, ['active', 'invited']),
        ),
      )
      .limit(1);
    if (!r) throw NOT_FOUND();
    return {
      target,
      name: r.displayName || r.name || r.email,
      status: r.status === 'active' ? 'active' : 'invited',
      membershipRole: r.role as MembershipRole,
      hasProfile: Boolean(r.profileId),
      details: {
        firstName: r.firstName,
        lastName: r.lastName,
        displayName: r.displayName ?? r.name,
        email: r.email,
        phone: r.phone,
        licenceNumber: r.licenceNumber,
        licenceExpiry: isoDay(r.licenceExpiry),
        territorySuburbs: r.territorySuburbs ?? [],
        operationalRole: asRole(r.operationalRole),
      },
    };
  }

  if (!uuid.safeParse(target.inviteId).success) throw NOT_FOUND();
  const [inv] = await db
    .select({ email: agentInvite.email, status: agentInvite.status, draft: agentInvite.draft })
    .from(agentInvite)
    .where(and(eq(agentInvite.id, target.inviteId), eq(agentInvite.agencyId, agencyId), eq(agentInvite.status, 'pending')))
    .limit(1);
  if (!inv) throw NOT_FOUND();
  const d = inviteAgentDraftSchema.safeParse(inv.draft);
  if (!d.success) throw new TeamEditError('conflict', 'This invite’s details cannot be read; withdraw it and send a new one');
  return {
    target,
    name: d.data.displayName || `${d.data.firstName} ${d.data.lastName}`.trim() || inv.email,
    status: 'invited',
    membershipRole: membershipRoleFromOperational(d.data.operationalRole),
    hasProfile: true,
    details: {
      firstName: d.data.firstName,
      lastName: d.data.lastName,
      displayName: d.data.displayName,
      email: inv.email,
      phone: d.data.phone,
      licenceNumber: d.data.licenceNumber,
      licenceExpiry: d.data.licenceExpiry ?? null,
      territorySuburbs: d.data.territorySuburbs,
      operationalRole: d.data.operationalRole,
    },
  };
}

function same(a: TeamMemberDetails[TeamEditField], b: TeamMemberDetails[TeamEditField]): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  }
  return (a ?? null) === (b ?? null);
}

/** The fields this patch would really change, compared with now. */
export function changedFields(now: TeamMemberDetails, patch: TeamMemberPatch): TeamEditField[] {
  return (Object.keys(patch) as TeamEditField[]).filter((k) => {
    const next = k === 'email' ? (patch.email as string).toLowerCase() : patch[k];
    return !same(now[k], next as TeamMemberDetails[TeamEditField]);
  });
}

/**
 * Every refusal that does not need a write, so the assistant's card and the
 * screen say the same sentence before anything is stored.
 */
export async function checkTeamEdit(db: Db, actor: Actor, t: LoadedTeamTarget, fields: TeamEditField[], patch: TeamMemberPatch): Promise<void> {
  if (t.target.kind === 'member') {
    if (fields.includes('email')) {
      throw new TeamEditError(
        'invalid',
        `${t.name}’s email is how they sign in, so only they can change it. Nothing was changed.`,
      );
    }
    const profileFields = fields.filter((f) => f !== 'displayName' && f !== 'phone');
    if (profileFields.length && !t.hasProfile) {
      throw new TeamEditError('invalid', `${t.name} has no agent profile, so only their name and phone can change here`);
    }
  }
  if (fields.includes('operationalRole')) {
    if (t.target.kind === 'member' && t.target.userId === actor.userId) {
      throw new TeamEditError('forbidden', 'You cannot change your own role');
    }
    if (t.membershipRole === 'owner') {
      throw new TeamEditError('forbidden', 'An owner’s role is not changed here');
    }
  }
  if (fields.includes('email') && t.target.kind === 'invite') {
    const email = (patch.email as string).toLowerCase();
    const agencyId = actor.agencyId as string;
    const [member] = await db
      .select({ id: membership.id })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .where(and(eq(membership.agencyId, agencyId), eq(sql`lower(${user.email})`, email)))
      .limit(1);
    if (member) throw new TeamEditError('conflict', 'Someone with that email is already a member of this agency');
    const [other] = await db
      .select({ id: agentInvite.id })
      .from(agentInvite)
      .where(
        and(
          eq(agentInvite.agencyId, agencyId),
          eq(sql`lower(${agentInvite.email})`, email),
          eq(agentInvite.status, 'pending'),
          gt(agentInvite.expiresAt, new Date()),
          ne(agentInvite.id, t.target.inviteId),
        ),
      )
      .limit(1);
    if (other) throw new TeamEditError('conflict', 'Another invite for that email is already waiting');
  }
}

export type TeamEditResult = {
  changed: TeamEditField[];
  /** Set when an invite's email changed: the new link (the old one no longer works). */
  claim: { inviteId: string; email: string; claimPath: string; expiresAt: Date } | null;
};

/**
 * Change a member's or a pending invite's details. `expected` = what a card
 * showed; if any of those fields changed since, nothing is written.
 */
export async function editTeamMember(
  db: Db,
  actor: Actor,
  target: TeamTarget,
  rawPatch: unknown,
  opts: { expected?: Partial<TeamMemberDetails> } = {},
): Promise<TeamEditResult> {
  const parsed = teamMemberPatchSchema.safeParse(rawPatch);
  if (!parsed.success) throw new TeamEditError('invalid', parsed.error.issues[0]?.message ?? 'Those details are not valid');
  const patch = parsed.data;
  const t = await loadTeamTarget(db, actor, target);

  if (opts.expected) {
    for (const [k, v] of Object.entries(opts.expected) as [TeamEditField, TeamMemberDetails[TeamEditField]][]) {
      if (!same(t.details[k], v)) {
        throw new TeamEditError('conflict', `${t.name}’s ${TEAM_FIELD_LABELS[k].toLowerCase()} changed after this was proposed`);
      }
    }
  }

  const fields = changedFields(t.details, patch);
  if (!fields.length) return { changed: [], claim: null };
  await checkTeamEdit(db, actor, t, fields, patch);
  const has = (f: TeamEditField) => fields.includes(f);

  if (target.kind === 'member') {
    await db.transaction(async (tx) => {
      const userSet = {
        ...(has('displayName') ? { name: patch.displayName } : {}),
        ...(has('phone') ? { phone: patch.phone } : {}),
      };
      if (Object.keys(userSet).length) {
        await tx.update(user).set({ ...userSet, updatedAt: sql`now()` }).where(eq(user.id, target.userId));
      }
      const profileSet = {
        ...(has('firstName') ? { firstName: patch.firstName } : {}),
        ...(has('lastName') ? { lastName: patch.lastName } : {}),
        ...(has('displayName') ? { displayName: patch.displayName } : {}),
        ...(has('licenceNumber') ? { licenceNumber: patch.licenceNumber } : {}),
        ...(has('licenceExpiry') ? { licenceExpiry: patch.licenceExpiry ? new Date(`${patch.licenceExpiry}T00:00:00.000Z`) : null } : {}),
        ...(has('territorySuburbs') ? { territorySuburbs: patch.territorySuburbs } : {}),
        ...(has('operationalRole') ? { operationalRole: patch.operationalRole } : {}),
      };
      if (Object.keys(profileSet).length && t.hasProfile) {
        await tx.update(agentProfile).set({ ...profileSet, updatedAt: sql`now()` }).where(eq(agentProfile.userId, target.userId));
      }
      if (has('operationalRole')) {
        await tx
          .update(membership)
          .set({ role: membershipRoleFromOperational(patch.operationalRole as OperationalRole), updatedAt: sql`now()` })
          .where(and(eq(membership.userId, target.userId), eq(membership.agencyId, actor.agencyId as string)));
      }
    });
    return { changed: fields, claim: null };
  }

  // A pending invite: the wizard's draft is the profile until it is claimed.
  const [row] = await db.select({ draft: agentInvite.draft }).from(agentInvite).where(eq(agentInvite.id, target.inviteId)).limit(1);
  const next = inviteAgentDraftSchema.parse({
    ...(row?.draft as Record<string, unknown>),
    ...Object.fromEntries(fields.map((f) => [f, f === 'email' ? (patch.email as string).toLowerCase() : patch[f]])),
  });
  const rotate = has('email');
  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + inviteTtlMinutes() * 60_000);
  const [updated] = await db
    .update(agentInvite)
    .set({
      draft: next,
      ...(rotate ? { email: next.email, token, expiresAt } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(agentInvite.id, target.inviteId), eq(agentInvite.status, 'pending')))
    .returning({ id: agentInvite.id });
  if (!updated) throw new TeamEditError('conflict', 'That invite was claimed or withdrawn meanwhile');
  return {
    changed: fields,
    claim: rotate
      ? { inviteId: target.inviteId, email: next.email, claimPath: `/signup?invite=${token}&email=${encodeURIComponent(next.email)}`, expiresAt }
      : null,
  };
}

/**
 * Take back a pending invite. Its link then says "This invite was withdrawn".
 * A second call finds nothing pending and is refused as not found.
 */
export async function withdrawInvite(db: Db, actor: Actor, inviteId: string): Promise<{ email: string }> {
  const agencyId = requireTeam(actor);
  if (!uuid.safeParse(inviteId).success) throw NOT_FOUND();
  const [done] = await db
    .update(agentInvite)
    .set({ status: 'revoked', updatedAt: sql`now()` })
    .where(and(eq(agentInvite.id, inviteId), eq(agentInvite.agencyId, agencyId), eq(agentInvite.status, 'pending')))
    .returning({ email: agentInvite.email });
  if (!done) throw new TeamEditError('not_found', 'That invite is no longer waiting (claimed, withdrawn or not found)');
  return done;
}
