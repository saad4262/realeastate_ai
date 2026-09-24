import { and, eq, gt, inArray, like, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  agency,
  agentInvite,
  agentProfile,
  membership,
  user,
  type Db,
  type DbOrTx,
} from '@repo/db';
import { can, membershipRolePhrase, type Actor } from '../permissions';
import {
  InviteAgentError,
  inviteAgentDraftSchema,
  membershipRoleFromOperational,
  slugifyAgentName,
  toInviteAgentError,
  TIER_SPLITS,
  type InviteAgentDraft,
} from './invite-schema';

export type InviteAgentResult = {
  inviteId: string;
  token: string;
  email: string;
  status: 'pending' | 'provisioned';
  userId?: string;
  membershipId?: string;
  claimPath: string;
  /** When the claim link stops working — shown next to the link. */
  expiresAt: Date;
};

export type AuthProvisioner = {
  /** Create or invite auth user; returns auth.users.id */
  provision(email: string, fullName: string): Promise<{ userId: string }>;
};

const FORBIDDEN = new InviteAgentError(
  'forbidden',
  'You do not have permission to invite agents to this agency',
);

function requireAgency(actor: Actor): string {
  if (!actor.agencyId) {
    throw FORBIDDEN;
  }
  if (!can(actor, 'team:manage', { type: 'team', agencyId: actor.agencyId })) {
    throw FORBIDDEN;
  }
  return actor.agencyId;
}

function newToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Invite lifetime — 2 hours. Long enough for the agent to open the email and
 * set a password, short enough that a leaked link goes stale. A lapsed link is
 * re-sent from the wizard, never extended. Override per environment with
 * AGENT_INVITE_TTL_MINUTES (see packages/config/src/env.ts).
 */
const DEFAULT_INVITE_TTL_MINUTES = 120;
const MAX_INVITE_TTL_MINUTES = 60 * 24 * 14;

export function inviteTtlMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AGENT_INVITE_TTL_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INVITE_TTL_MINUTES;
  return Math.min(Math.round(raw), MAX_INVITE_TTL_MINUTES);
}

/** "4 minutes" / "2 hours" — a countdown reads better than a timestamp. */
export function formatRemaining(expiresAt: Date, now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((expiresAt.getTime() - now) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * A free slug for this agent, chosen before the transaction opens.
 *
 * The old code inserted, caught the unique violation and tried the next
 * suffix. That cannot live inside a transaction: in Postgres a failed
 * statement aborts the whole transaction, so the retry would hit
 * "current transaction is aborted" and every later write would fail too.
 *
 * Reading the taken slugs first turns twenty possible round trips into one.
 * A genuine race — two agents with the same name provisioned in the same
 * instant — still hits the unique index and rolls the whole thing back, which
 * is the correct outcome: an error the caller can retry, not a half-written
 * agent.
 */
async function pickSlug(db: DbOrTx, base: string): Promise<string> {
  const taken = new Set(
    (
      await db
        .select({ slug: agentProfile.slug })
        .from(agentProfile)
        .where(like(agentProfile.slug, `${base}%`))
    ).map((r) => r.slug),
  );

  if (!taken.has(base)) return base;
  for (let n = 1; n <= 50; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('Could not allocate agent profile slug');
}

/**
 * Create the user, the membership and the agent profile.
 *
 * Three rows describing one person joining one agency. Written separately, a
 * failure on the profile left a membership with nobody behind it: the agent
 * appears in the team list, has no licence details, and cannot be fixed from
 * the UI because the wizard only creates.
 *
 * Takes a handle rather than opening its own transaction, because both callers
 * have more to write afterwards — claiming an invite also has to mark the
 * invite accepted and the membership active, and those belong in the same
 * all-or-nothing as these.
 */
async function materialiseAgent(
  tx: DbOrTx,
  opts: {
    agencyId: string;
    userId: string;
    invitedBy?: string;
    draft: InviteAgentDraft;
  },
) {
  const { agencyId, userId, invitedBy, draft } = opts;
  const tier = TIER_SPLITS[draft.commissionTier];
  const role = membershipRoleFromOperational(draft.operationalRole);
  const fullName = `${draft.firstName} ${draft.lastName}`.trim();
  const slugBase = slugifyAgentName(draft.displayName || fullName, draft.licenceNumber);

  {
    await tx
      .insert(user)
      .values({
        id: userId,
        email: draft.email.toLowerCase(),
        name: draft.displayName || fullName,
        phone: draft.phone,
        avatarUrl: draft.photoUrl ?? null,
      })
      .onConflictDoUpdate({
        target: user.id,
        set: {
          email: draft.email.toLowerCase(),
          name: draft.displayName || fullName,
          phone: draft.phone,
          avatarUrl: draft.photoUrl ?? null,
          updatedAt: sql`now()`,
        },
      });

    // One membership per (user, agency) — a re-claim updates instead of
    // duplicating.
    const [mem] = await tx
      .insert(membership)
      .values({
        userId,
        agencyId,
        role,
        status: 'invited',
        invitedBy: invitedBy ?? null,
      })
      .onConflictDoUpdate({
        target: [membership.userId, membership.agencyId],
        set: { role, updatedAt: sql`now()` },
      })
      .returning();

    if (!mem) throw new Error('Failed to create membership');

    const [existingProfile] = await tx
      .select({ id: agentProfile.id })
      .from(agentProfile)
      .where(eq(agentProfile.userId, userId))
      .limit(1);

    if (existingProfile) return { membershipId: mem.id };

    await tx.insert(agentProfile).values({
      userId,
      slug: await pickSlug(tx, slugBase),
      // Legal names, kept apart from the display name — a licence check
      // cannot be run against "Danny V".
      firstName: draft.firstName,
      lastName: draft.lastName,
      displayName: draft.displayName || fullName,
      bio: draft.bio ?? null,
      photoUrl: draft.photoUrl ?? null,
      languages: draft.languages,
      specialties: draft.specialties,
      licenceNumber: draft.licenceNumber,
      licenceClass: draft.licenceClass,
      licenceExpiry: draft.licenceExpiry
        ? new Date(`${draft.licenceExpiry}T00:00:00.000Z`)
        : null,
      territorySuburbs: draft.territorySuburbs,
      territoryRadiusKm: String(draft.territoryRadiusKm),
      commissionTier: draft.commissionTier,
      commissionSplitAgent: draft.commissionSplitAgent || tier.agent,
      commissionSplitAgency: draft.commissionSplitAgency || tier.agency,
      operationalRole: draft.operationalRole,
      permissionFlags: draft.permissionFlags,
      public: false,
    });

    return { membershipId: mem.id };
  }
}

/**
 * Create an agent invite (and optionally provision auth + membership rows).
 * Always authorized via can(team:manage).
 */
export async function inviteAgent(
  db: Db,
  actor: Actor,
  rawDraft: unknown,
  auth?: AuthProvisioner,
): Promise<InviteAgentResult> {
  const agencyId = requireAgency(actor);
  const parsed = inviteAgentDraftSchema.safeParse(rawDraft);
  if (!parsed.success) {
    throw toInviteAgentError(parsed.error);
  }
  const draft = parsed.data;
  draft.email = draft.email.toLowerCase();

  // Any membership counts, not just agents — the owner and admins hold one too,
  // and membership(user_id, agency_id) is unique, so a second one cannot exist.
  const [existingMember] = await db
    .select({
      userId: membership.userId,
      role: membership.role,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(
        eq(membership.agencyId, agencyId),
        eq(sql`lower(${user.email})`, draft.email),
      ),
    )
    .limit(1);

  if (existingMember) {
    if (existingMember.userId === actor.userId) {
      throw new InviteAgentError(
        'self_invite',
        `You cannot invite yourself — you are already ${membershipRolePhrase(existingMember.role)} of this agency`,
        'email',
      );
    }
    throw new InviteAgentError(
      'already_member',
      'An account with this email is already a member of your agency',
      'email',
    );
  }

  // Lapsed invites are retired first, so they neither block a resend nor sit
  // in the table claiming to be pending.
  await db
    .update(agentInvite)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(
      and(
        eq(agentInvite.agencyId, agencyId),
        eq(sql`lower(${agentInvite.email})`, draft.email),
        eq(agentInvite.status, 'pending'),
        sql`${agentInvite.expiresAt} <= now()`,
      ),
    );

  const [pending] = await db
    .select({ id: agentInvite.id, expiresAt: agentInvite.expiresAt })
    .from(agentInvite)
    .where(
      and(
        eq(agentInvite.agencyId, agencyId),
        eq(sql`lower(${agentInvite.email})`, draft.email),
        eq(agentInvite.status, 'pending'),
        gt(agentInvite.expiresAt, sql`now()`),
      ),
    )
    .limit(1);

  if (pending) {
    throw new InviteAgentError(
      'invite_pending',
      `An invite for this email was already sent — it expires in ${formatRemaining(pending.expiresAt)}. Send a new one after it lapses.`,
      'email',
    );
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + inviteTtlMinutes() * 60_000);

  const [invite] = await db
    .insert(agentInvite)
    .values({
      agencyId,
      email: draft.email,
      token,
      status: 'pending',
      draft,
      invitedBy: actor.userId,
      expiresAt,
    })
    .returning();

  if (!invite) throw new Error('Failed to create invite');

  const claimPath = `/signup?invite=${token}&email=${encodeURIComponent(draft.email)}`;

  if (!auth) {
    return {
      inviteId: invite.id,
      token,
      email: draft.email,
      status: 'pending',
      claimPath,
      expiresAt,
    };
  }

  const { userId } = await auth.provision(
    draft.email,
    draft.displayName || `${draft.firstName} ${draft.lastName}`,
  );

  // The auth provider is called above, outside this: it is a network call and
  // its own system of record, so it cannot be rolled back by us anyway. What
  // follows is ours, and it goes together — an invite pointing at a membership
  // that was never created is an invite nobody can claim.
  const { membershipId } = await db.transaction(async (tx) => {
    const result = await materialiseAgent(tx, {
      agencyId,
      userId,
      invitedBy: actor.userId,
      draft,
    });

    await tx
      .update(agentInvite)
      .set({
        userId,
        membershipId: result.membershipId,
        updatedAt: sql`now()`,
      })
      .where(eq(agentInvite.id, invite.id));

    return result;
  });

  return {
    inviteId: invite.id,
    token,
    email: draft.email,
    status: 'provisioned',
    userId,
    membershipId,
    claimPath,
    expiresAt,
  };
}

export type ClaimInviteResult = {
  claimed: boolean;
  membershipId?: string;
  /**
   * Why nothing was claimed. 'expired' and 'none' look identical to the
   * caller otherwise, and with a short TTL an expired link is the common
   * case — the signup screen has to say so instead of sending the agent
   * off to register an agency of their own.
   */
  reason?: 'none' | 'expired';
};

/**
 * After signup/login: claim a pending invite for this email / token and create membership.
 */
export async function claimAgentInvite(
  db: Db,
  opts: { userId: string; email: string; token?: string | null },
): Promise<ClaimInviteResult> {
  const email = opts.email.toLowerCase();
  const now = Date.now();

  const rows = await db
    .select()
    .from(agentInvite)
    .where(
      and(
        eq(agentInvite.email, email),
        eq(agentInvite.status, 'pending'),
      ),
    )
    .limit(5);

  async function retire(ids: string[]) {
    if (!ids.length) return;
    await db
      .update(agentInvite)
      .set({ status: 'expired', updatedAt: sql`now()` })
      .where(inArray(agentInvite.id, ids));
  }

  const invite =
    (opts.token ? rows.find((r) => r.token === opts.token) : undefined) ??
    rows.find((r) => r.expiresAt.getTime() > now);

  if (!invite) {
    const lapsed = rows.filter((r) => r.expiresAt.getTime() <= now);
    await retire(lapsed.map((r) => r.id));
    return { claimed: false, reason: lapsed.length ? 'expired' : 'none' };
  }

  if (invite.expiresAt.getTime() <= now) {
    await retire([invite.id]);
    return { claimed: false, reason: 'expired' };
  }

  const draft = inviteAgentDraftSchema.parse(invite.draft);

  // Already provisioned under another path
  if (invite.membershipId && invite.userId === opts.userId) {
    const membershipId = invite.membershipId;
    // Accepting the invite and activating the membership are one act. Split,
    // a failure between them leaves an accepted invite the agent cannot use
    // and a membership stuck at "invited".
    await db.transaction(async (tx) => {
      await tx
        .update(agentInvite)
        .set({ status: 'accepted', updatedAt: sql`now()` })
        .where(eq(agentInvite.id, invite.id));
      await tx
        .update(membership)
        .set({ status: 'active', updatedAt: sql`now()` })
        .where(eq(membership.id, membershipId));
    });
    return { claimed: true, membershipId };
  }

  if (invite.userId && invite.userId !== opts.userId) {
    throw new Error('This invite is linked to a different account');
  }

  /**
   * Five rows, one act: the agent joins.
   *
   * user, membership and agent_profile from materialiseAgent, then the
   * membership goes active and the invite is marked accepted. Any of these
   * failing on its own used to leave a state nobody can get out of — an agent
   * with an active membership and an invite still open to be claimed again, or
   * an accepted invite pointing at a membership that was never activated.
   */
  const membershipId = await db.transaction(async (tx) => {
    const result = await materialiseAgent(tx, {
      agencyId: invite.agencyId,
      userId: opts.userId,
      invitedBy: invite.invitedBy ?? undefined,
      draft,
    });

    await tx
      .update(membership)
      .set({ status: 'active', updatedAt: sql`now()` })
      .where(eq(membership.id, result.membershipId));

    await tx
      .update(agentInvite)
      .set({
        status: 'accepted',
        userId: opts.userId,
        membershipId: result.membershipId,
        updatedAt: sql`now()`,
      })
      .where(eq(agentInvite.id, invite.id));

    return result.membershipId;
  });

  return { claimed: true, membershipId };
}


/**
 * Why a claim link is or is not usable.
 *
 * 'accepted' and 'expired' must stay apart: an accepted invite means the
 * agent is already in the roster and should sign in, which is the opposite
 * of what "expired" tells them to do.
 */
export type InviteState = 'live' | 'expired' | 'accepted' | 'revoked';

export type InvitePreview = {
  email: string;
  agencyName: string;
  expiresAt: Date;
  state: InviteState;
};

function inviteState(status: string, expiresAt: Date, now = Date.now()): InviteState {
  if (status === 'accepted') return 'accepted';
  if (status === 'revoked') return 'revoked';
  if (status !== 'pending') return 'expired';
  return expiresAt.getTime() <= now ? 'expired' : 'live';
}

/**
 * Read an invite by its token, for the claim screen.
 *
 * Deliberately unauthenticated — the token is the secret, and the person
 * holding it is the one being invited. It returns only what that screen has
 * to show, so the URL's own ?email= (which anyone can edit) is never what
 * the agent is asked to confirm. Claiming is still gated on the session's
 * real email in claimAgentInvite.
 */
export async function peekAgentInvite(
  db: Db,
  token: string,
): Promise<InvitePreview | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const [row] = await db
    .select({
      email: agentInvite.email,
      expiresAt: agentInvite.expiresAt,
      status: agentInvite.status,
      agencyName: agency.name,
    })
    .from(agentInvite)
    .innerJoin(agency, eq(agency.id, agentInvite.agencyId))
    .where(eq(agentInvite.token, trimmed))
    .limit(1);

  if (!row) return null;

  return {
    email: row.email,
    agencyName: row.agencyName,
    expiresAt: row.expiresAt,
    state: inviteState(row.status, row.expiresAt),
  };
}
