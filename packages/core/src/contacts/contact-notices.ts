import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { membership, user, type Db } from '@repo/db';
import { buildContactAssignedEmail } from '../email';
import type { NoticeDeps, NoticeOutcome } from '../leads/lead-notices';
import { can, type Actor, type MembershipRole } from '../permissions';
import { CONTACT_ROLE_LABELS } from './contact-schema';
import { loadContactHead } from './get-contact';
import { roleArray } from './list-contacts';
import { contactResource } from './visibility';

const assigner = alias(user, 'assigner');

/**
 * Tell a member a contact is now theirs (ADR 0018) — the lead notice's rule:
 *  - not when somebody assigns a contact to themselves (they know);
 *  - only while the contact is STILL assigned to them (a quick re-assign
 *    does not send a stale email);
 *  - only to an active member, judged by can() as the person the screen would
 *    show it to (`contact:read` as its assignee).
 *
 * Callers run it after the write, outside any transaction, and never let it
 * fail the assignment: a contact that was assigned and not mailed is still
 * assigned.
 */
export async function notifyContactAssigned(
  db: Db,
  deps: NoticeDeps,
  contactId: string,
  assigneeUserId: string,
  assignedBy: string,
): Promise<NoticeOutcome> {
  const none = { sent: 0, failed: 0 };
  if (assigneeUserId === assignedBy) return none;

  const [person] = await db
    .select({
      userId: user.id,
      email: user.email,
      name: user.name,
      role: membership.role,
      agencyId: membership.agencyId,
      assignerName: assigner.name,
      assignerEmail: assigner.email,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .leftJoin(assigner, eq(assigner.id, assignedBy))
    .where(and(eq(membership.userId, assigneeUserId), eq(membership.status, 'active')))
    .limit(1);
  if (!person) return none;

  const actor: Actor = {
    userId: person.userId,
    agencyId: person.agencyId,
    membershipRole: person.role as MembershipRole,
  };
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId || head.row.assignedTo !== assigneeUserId) return none;
  if (!can(actor, 'contact:read', contactResource(head.facts))) return none;

  const host = can(actor, 'console:agency', { type: 'console' })
    ? `${deps.urls.agencyUrl}/customers`
    : `${deps.urls.agentUrl}/my-contacts`;
  const message = buildContactAssignedEmail({
    to: { email: person.email, ...(person.name ? { name: person.name } : {}) },
    from: deps.mailer.sender.from,
    postalAddress: deps.mailer.sender.postalAddress,
    contact: {
      name: head.row.name,
      email: head.row.email,
      phone: head.row.phone,
      roles: roleArray(head.row.roles).map((r) => CONTACT_ROLE_LABELS[r]),
      nextAction: head.row.nextAction,
    },
    assignedByName: person.assignerName || person.assignerEmail || null,
    profileUrl: `${host}/${head.row.id}`,
  });
  const result = await deps.mailer.transport.send(message);
  if (result.ok) return { sent: 1, failed: 0 };
  // The contact id, never the recipient's address — this reaches logs.
  console.error(`[contact-notice] assignment notice for contact ${contactId} not sent: ${result.error}`);
  return { sent: 0, failed: 1 };
}
