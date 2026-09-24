import { asc, eq } from 'drizzle-orm';
import { agentInvite, agentProfile, membership, user, type Db } from '@repo/db';
import { can, isAgencyAdminRole, type Actor, type MembershipRole } from '../permissions';
import { inviteAgentDraftSchema, membershipRoleFromOperational } from './invite-schema';

export type AgencyAgentRow = {
  userId: string;
  membershipId: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  /** Legal names from the licence, separate from the display name. */
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  photoUrl: string | null;
  bio: string | null;
  licenceNumber: string | null;
  licenceClass: string | null;
  /** ISO date; the console shows how close it is to lapsing. */
  licenceExpiry: string | null;
  territorySuburbs: string[] | null;
  territoryRadiusKm: number | null;
  specialties: string[] | null;
  languages: string[] | null;
  operationalRole: string | null;
  commissionTier: string | null;
  commissionSplitAgent: number | null;
  commissionSplitAgency: number | null;
  permissionFlags: Record<string, boolean> | null;
  /** agent_profile.public — whether this agent appears on the consumer site. */
  publicProfile: boolean;
  joinedAt: string | null;
  /** Owner/admin run the agency — they are team, not part of the agent roster. */
  isAgencyAdmin: boolean;
};

/**
 * List agents for the actor's agency. Requires team:manage (agency console).
 * Includes pending invites (no auth user yet) as status=invited rows.
 */
export async function listAgencyAgents(
  db: Db,
  actor: Actor,
): Promise<AgencyAgentRow[]> {
  if (
    !actor.agencyId ||
    !can(actor, 'team:manage', { type: 'team', agencyId: actor.agencyId })
  ) {
    throw new Error('Forbidden');
  }

  const membersQuery = db
    .select({
      userId: user.id,
      membershipId: membership.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: membership.role,
      status: membership.status,
      firstName: agentProfile.firstName,
      lastName: agentProfile.lastName,
      displayName: agentProfile.displayName,
      photoUrl: agentProfile.photoUrl,
      bio: agentProfile.bio,
      licenceNumber: agentProfile.licenceNumber,
      licenceClass: agentProfile.licenceClass,
      licenceExpiry: agentProfile.licenceExpiry,
      territorySuburbs: agentProfile.territorySuburbs,
      territoryRadiusKm: agentProfile.territoryRadiusKm,
      specialties: agentProfile.specialties,
      languages: agentProfile.languages,
      operationalRole: agentProfile.operationalRole,
      commissionTier: agentProfile.commissionTier,
      commissionSplitAgent: agentProfile.commissionSplitAgent,
      commissionSplitAgency: agentProfile.commissionSplitAgency,
      permissionFlags: agentProfile.permissionFlags,
      publicProfile: agentProfile.public,
      joinedAt: membership.createdAt,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .leftJoin(agentProfile, eq(agentProfile.userId, membership.userId))
    .where(eq(membership.agencyId, actor.agencyId))
    .orderBy(asc(user.name));

  // The roster and the outstanding invites do not depend on each other, so
  // they go out together — each round trip to the database region is ~190 ms,
  // and running them in sequence simply doubled that for no reason.
  const invitesQuery = db
    .select()
    .from(agentInvite)
    .where(eq(agentInvite.agencyId, actor.agencyId));

  const [rows, invites] = await Promise.all([membersQuery, invitesQuery]);

  // Dates and numerics come back as Date / string from the driver; the row is
  // rendered in a client component, so both are normalised here rather than at
  // the boundary where a Date would silently become an object.
  const members: AgencyAgentRow[] = rows.map((r) => ({
    ...r,
    name: r.displayName || r.name || r.email,
    licenceExpiry: r.licenceExpiry ? r.licenceExpiry.toISOString() : null,
    territoryRadiusKm: r.territoryRadiusKm === null ? null : Number(r.territoryRadiusKm),
    joinedAt: r.joinedAt ? r.joinedAt.toISOString() : null,
    // The profile is left-joined, so even its NOT NULL columns arrive as null
    // for an admin who has no agent profile at all.
    publicProfile: r.publicProfile ?? false,
    isAgencyAdmin: isAgencyAdminRole(r.role as MembershipRole),
  }));

  const memberEmails = new Set(members.map((m) => m.email.toLowerCase()));

  for (const inv of invites) {
    if (inv.status !== 'pending') continue;
    if (memberEmails.has(inv.email.toLowerCase())) continue;
    const draft = inviteAgentDraftSchema.safeParse(inv.draft);
    if (!draft.success) continue;
    const d = draft.data;
    // A pending invite has no profile row yet, so the wizard draft stands in
    // for one — the directory shows the same fields either way.
    members.push({
      userId: inv.id,
      membershipId: inv.id,
      name: d.displayName || `${d.firstName} ${d.lastName}`.trim(),
      email: inv.email,
      phone: d.phone,
      role: membershipRoleFromOperational(d.operationalRole),
      status: 'invited',
      firstName: d.firstName,
      lastName: d.lastName,
      displayName: d.displayName,
      photoUrl: d.photoUrl ?? null,
      bio: d.bio ?? null,
      licenceNumber: d.licenceNumber,
      licenceClass: d.licenceClass,
      licenceExpiry: d.licenceExpiry
        ? new Date(`${d.licenceExpiry}T00:00:00.000Z`).toISOString()
        : null,
      territorySuburbs: d.territorySuburbs,
      territoryRadiusKm: d.territoryRadiusKm,
      specialties: d.specialties,
      languages: d.languages,
      operationalRole: d.operationalRole,
      commissionTier: d.commissionTier,
      commissionSplitAgent: d.commissionSplitAgent,
      commissionSplitAgency: d.commissionSplitAgency,
      permissionFlags: d.permissionFlags,
      publicProfile: false,
      joinedAt: inv.createdAt ? inv.createdAt.toISOString() : null,
      isAgencyAdmin: false,
    });
  }

  return members;
}
