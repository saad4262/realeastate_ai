import { and, desc, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { agentInvite, membership, user, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import {
  InviteAgentError,
  inviteAgentDraftSchema,
  type InviteAgentDraft,
} from './invite-schema';
import { inviteTtlMinutes, type InviteState } from './invite-agent';

const FORBIDDEN = new InviteAgentError(
  'forbidden',
  'You do not have permission to manage invites for this agency',
);

function requireAgency(actor: Actor): string {
  if (!actor.agencyId) throw FORBIDDEN;
  if (!can(actor, 'team:manage', { type: 'team', agencyId: actor.agencyId })) {
    throw FORBIDDEN;
  }
  return actor.agencyId;
}

export type AgencyInviteRow = {
  id: string;
  email: string;
  name: string;
  /** The claim link's path. Only reaches someone who can already manage the team. */
  claimPath: string;
  expiresAt: Date;
  state: InviteState;
};

function rowState(status: string, expiresAt: Date): InviteState {
  if (status === 'accepted') return 'accepted';
  if (status === 'revoked') return 'revoked';
  if (status !== 'pending') return 'expired';
  return expiresAt.getTime() <= Date.now() ? 'expired' : 'live';
}

function claimPathFor(token: string, email: string): string {
  return `/signup?invite=${token}&email=${encodeURIComponent(email)}`;
}

function nameFromDraft(draft: InviteAgentDraft, fallback: string): string {
  return draft.displayName || `${draft.firstName} ${draft.lastName}`.trim() || fallback;
}

/**
 * Outstanding invites for the actor's agency — live and lapsed both, so the
 * console can show the link again later and offer a fresh one once it runs out.
 * Accepted invites are left out: those people are in the roster already.
 */
export async function listAgencyInvites(
  db: Db,
  actor: Actor,
): Promise<AgencyInviteRow[]> {
  const agencyId = requireAgency(actor);

  const invitesQuery = db
    .select({
      id: agentInvite.id,
      email: agentInvite.email,
      token: agentInvite.token,
      status: agentInvite.status,
      draft: agentInvite.draft,
      expiresAt: agentInvite.expiresAt,
    })
    .from(agentInvite)
    .where(eq(agentInvite.agencyId, agencyId))
    .orderBy(desc(agentInvite.createdAt));

  // Anyone already on the roster is shown by the directory, not here — and
  // resend refuses them, so a row for them would be a button that only fails.
  const membersQuery = db
    .select({ email: sql<string>`lower(${user.email})` })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.agencyId, agencyId));

  // Independent of each other — one round trip, not two.
  const [rows, members] = await Promise.all([invitesQuery, membersQuery]);
  const memberEmails = new Set(members.map((m) => m.email));

  const out: AgencyInviteRow[] = [];
  for (const r of rows) {
    const state = rowState(r.status, r.expiresAt);
    if (state === 'accepted' || state === 'revoked') continue;
    if (memberEmails.has(r.email.toLowerCase())) continue;

    const parsed = inviteAgentDraftSchema.safeParse(r.draft);
    out.push({
      id: r.id,
      email: r.email,
      name: parsed.success ? nameFromDraft(parsed.data, r.email) : r.email,
      claimPath: claimPathFor(r.token, r.email),
      expiresAt: r.expiresAt,
      state,
    });
  }
  return out;
}

export type ResendInviteResult = {
  inviteId: string;
  email: string;
  claimPath: string;
  expiresAt: Date;
};

/**
 * Issue a fresh link for an existing invite.
 *
 * The token is rotated rather than reused, so a link that has been shared
 * around stops working the moment a new one is cut — that is the whole point
 * of the short lifetime. The dossier in `draft` is untouched.
 */
export async function resendAgentInvite(
  db: Db,
  actor: Actor,
  inviteId: string,
): Promise<ResendInviteResult> {
  const agencyId = requireAgency(actor);

  const [invite] = await db
    .select({
      id: agentInvite.id,
      email: agentInvite.email,
      status: agentInvite.status,
    })
    .from(agentInvite)
    .where(and(eq(agentInvite.id, inviteId), eq(agentInvite.agencyId, agencyId)))
    .limit(1);

  if (!invite) {
    throw new InviteAgentError('unknown', 'That invite no longer exists');
  }
  if (invite.status === 'accepted') {
    throw new InviteAgentError(
      'already_member',
      'This invite was already accepted — that person is on your team',
    );
  }

  // Status alone is not enough. Someone can join through a different invite
  // row, or be added directly, leaving an older row sitting at 'expired' —
  // re-issuing that one would hand a live link to an existing member.
  const [alreadyMember] = await db
    .select({ userId: membership.userId })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(
        eq(membership.agencyId, agencyId),
        eq(sql`lower(${user.email})`, invite.email.toLowerCase()),
      ),
    )
    .limit(1);

  if (alreadyMember) {
    throw new InviteAgentError(
      'already_member',
      'An account with this email is already a member of your agency',
    );
  }

  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + inviteTtlMinutes() * 60_000);

  await db
    .update(agentInvite)
    .set({ token, status: 'pending', expiresAt, updatedAt: sql`now()` })
    .where(eq(agentInvite.id, invite.id));

  return {
    inviteId: invite.id,
    email: invite.email,
    claimPath: claimPathFor(token, invite.email),
    expiresAt,
  };
}
