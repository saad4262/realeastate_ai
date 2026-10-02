import { and, eq } from 'drizzle-orm';
import { agency, agentInvite, user, type Db } from '@repo/db';
import { buildAgentInviteEmail, type EmailTransport, type SenderIdentity } from '../email';
import { can, type Actor } from '../permissions';
import { formatRemaining } from './invite-agent';

export type InviteEmailDeps = {
  mailer: { sender: SenderIdentity; transport: EmailTransport };
  /** Origin of the agent host — the claim page lives there, not on agency.* */
  agentUrl: string;
};

export type InviteEmailOutcome = { emailed: true } | { emailed: false; reason: string };

/**
 * Mail an agent the link to claim their invite.
 *
 * Called by the console right after `inviteAgent` or `resendAgentInvite` cut a
 * token, with the claim path they returned — the token is never read back out
 * of the table for this. The console still shows the link with a Copy button,
 * so a failed send costs the admin one paste, never the invite: this returns
 * an outcome rather than throwing, and the screen says which happened.
 *
 * Asked through can() again rather than trusting the caller ran the invite: a
 * send to an arbitrary address is the thing to refuse.
 */
export async function emailAgentInvite(
  db: Db,
  deps: InviteEmailDeps,
  actor: Actor,
  invite: { inviteId: string; claimPath: string; expiresAt: Date },
): Promise<InviteEmailOutcome> {
  if (!actor.agencyId || !can(actor, 'team:manage', { type: 'team', agencyId: actor.agencyId })) {
    return { emailed: false, reason: 'Not allowed to send invites for this agency' };
  }

  const [row] = await db
    .select({
      email: agentInvite.email,
      status: agentInvite.status,
      draft: agentInvite.draft,
      agencyName: agency.name,
      invitedBy: user.name,
    })
    .from(agentInvite)
    .innerJoin(agency, eq(agency.id, agentInvite.agencyId))
    .leftJoin(user, eq(user.id, agentInvite.invitedBy))
    .where(and(eq(agentInvite.id, invite.inviteId), eq(agentInvite.agencyId, actor.agencyId)))
    .limit(1);

  if (!row || row.status !== 'pending') {
    return { emailed: false, reason: 'That invite is no longer open' };
  }

  const draft = (row.draft ?? {}) as { firstName?: string; lastName?: string; displayName?: string };
  const name = draft.displayName?.trim() || [draft.firstName, draft.lastName].filter(Boolean).join(' ').trim();

  const { sender, transport } = deps.mailer;
  const result = await transport.send(
    buildAgentInviteEmail({
      to: { email: row.email, ...(name ? { name } : {}) },
      from: sender.from,
      postalAddress: sender.postalAddress,
      agencyName: row.agencyName,
      invitedBy: row.invitedBy,
      claimUrl: `${deps.agentUrl}${invite.claimPath}`,
      validFor: formatRemaining(invite.expiresAt),
    }),
  );

  if (!result.ok) {
    console.error(`[invite] email for invite ${invite.inviteId} not sent: ${result.error}`);
    return { emailed: false, reason: 'The email could not be sent' };
  }
  return { emailed: true };
}
