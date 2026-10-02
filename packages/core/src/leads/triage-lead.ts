import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { lead, leadStatusEnum, membership, type DbOrTx } from '@repo/db';
import { can, type Actor, type MembershipRole, type Resource } from '../permissions';
import type { LeadStatus } from './list-leads';

/**
 * Triage: moving a lead along, and deciding whose job it is.
 *
 * `lead.status` and `lead.assigned_to` existed from the first migration and
 * nothing wrote them, so every offer an agency ever received sat at "new"
 * forever. These two writes are the whole of what was missing.
 *
 * ## Why every refusal on a lead from another agency is "not found"
 *
 * The lead is read scoped by the actor's own agency. A lead id from another
 * tenancy therefore never loads, and the answer is the same as for an id that
 * does not exist — confirming "that lead exists, it is just not yours" would
 * tell one agency something about another's pipeline.
 */

export const leadStatusSchema = z.enum(leadStatusEnum.enumValues);

export type TriageErrorCode = 'forbidden' | 'not_found' | 'invalid' | 'conflict';

export class LeadTriageError extends Error {
  readonly code: TriageErrorCode;
  constructor(code: TriageErrorCode, message: string) {
    super(message);
    this.name = 'LeadTriageError';
    this.code = code;
  }
}

const NOT_FOUND = () => new LeadTriageError('not_found', 'That lead no longer exists');

type Loaded = {
  id: string;
  agencyId: string;
  kind: string;
  assignedTo: string | null;
  listingId: string | null;
};

/** The lead, inside the actor's own agency or not at all. */
async function loadLead(db: DbOrTx, actor: Actor, leadId: string): Promise<Loaded> {
  if (!actor.agencyId) throw NOT_FOUND();
  // A malformed id is a missing lead, not a 500 from Postgres's uuid parser.
  if (!z.string().uuid().safeParse(leadId).success) throw NOT_FOUND();

  const [row] = await db
    .select({
      id: lead.id,
      agencyId: lead.agencyId,
      kind: lead.kind,
      assignedTo: lead.assignedTo,
      listingId: lead.listingId,
    })
    .from(lead)
    .where(and(eq(lead.id, leadId), eq(lead.agencyId, actor.agencyId)))
    .limit(1);

  if (!row) throw NOT_FOUND();
  return row;
}

function resourceFor(row: Loaded): Resource {
  return {
    type: 'lead',
    id: row.id,
    agencyId: row.agencyId,
    listingId: row.listingId,
    ...(row.assignedTo ? { ownerId: row.assignedTo } : {}),
  };
}

/**
 * An offer adds one more question to every decision: may this person see it?
 * Asked through can() like the rest, never as a role comparison here (#2).
 */
function maySee(actor: Actor, row: Loaded): boolean {
  // This lead specifically (ADR 0014): an agent's own, or their listing's.
  if (!can(actor, 'lead:read', resourceFor(row))) return false;
  return row.kind !== 'offer' || can(actor, 'lead:read_offer', resourceFor(row));
}

/** Offer visibility alone, for judging somebody who does not hold the lead yet. */
function maySeeKind(actor: Actor, row: Loaded): boolean {
  return row.kind !== 'offer' || can(actor, 'lead:read_offer', { type: 'lead', agencyId: row.agencyId });
}

/** Where a lead stands after a write, for the UI to reconcile against. */
export type TriagedLead = {
  id: string;
  status: LeadStatus;
  assignedTo: string | null;
};

/**
 * Move a lead to another triage status.
 *
 * Any status to any other, including back to "new": reopening a lead somebody
 * closed too early is ordinary, and a state machine that refused it would just
 * be worked around.
 *
 * ## The assignment is part of the WHERE
 *
 * Permission for a non-admin rests on the lead being assigned to them, and that
 * was read a moment ago. If an admin reassigns it in between, the agent's
 * write must not land on a lead that is no longer theirs — so the update only
 * matches while `assigned_to` is still what the decision was made on, and a
 * miss is a conflict the UI answers by refreshing.
 */
export async function updateLeadStatus(
  db: DbOrTx,
  actor: Actor,
  leadId: string,
  status: unknown,
): Promise<TriagedLead> {
  const parsed = leadStatusSchema.safeParse(status);
  if (!parsed.success) throw new LeadTriageError('invalid', 'Choose a status from the list');

  const row = await loadLead(db, actor, leadId);
  // A lead this actor may not see — another agent's, or an offer — is, to
  // them, a lead that does not exist.
  if (!maySee(actor, row)) throw NOT_FOUND();
  if (!can(actor, 'lead:update', resourceFor(row))) {
    throw new LeadTriageError('forbidden', 'Only an admin or the person this lead is assigned to can update it');
  }

  const [updated] = await db
    .update(lead)
    .set({ status: parsed.data, updatedAt: sql`now()` })
    .where(
      and(
        eq(lead.id, row.id),
        eq(lead.agencyId, row.agencyId),
        row.assignedTo === null ? isNull(lead.assignedTo) : eq(lead.assignedTo, row.assignedTo),
      ),
    )
    .returning({ id: lead.id, status: lead.status, assignedTo: lead.assignedTo });

  if (!updated) {
    throw new LeadTriageError('conflict', 'This lead was reassigned a moment ago — refresh and try again');
  }
  return { id: updated.id, status: updated.status as LeadStatus, assignedTo: updated.assignedTo };
}

/**
 * Give a lead to a member of the agency, or take it back with `null`.
 *
 * ## Who can receive one
 *
 * An ACTIVE member of the same agency — and, for an offer, a member who would
 * be allowed to read it. Assigning an offer to an agent who cannot open the
 * Offers tab would hand them a job they cannot see, and quietly widen who
 * learns an offer exists. The assignee is judged by the same can() as anybody
 * else, built from their own membership.
 *
 * ## The membership check is part of the write
 *
 * Read first for a clear error, and then repeated as an EXISTS in the UPDATE,
 * so a member removed between the two cannot end up holding the lead.
 */
export async function assignLead(
  db: DbOrTx,
  actor: Actor,
  leadId: string,
  assigneeUserId: string | null,
): Promise<TriagedLead> {
  const row = await loadLead(db, actor, leadId);
  if (!maySee(actor, row)) throw NOT_FOUND();
  if (!can(actor, 'lead:assign', resourceFor(row))) {
    throw new LeadTriageError('forbidden', 'Only an agency admin can assign leads');
  }

  if (assigneeUserId !== null) {
    if (!z.string().uuid().safeParse(assigneeUserId).success) {
      throw new LeadTriageError('invalid', 'That person is not an active member of this agency');
    }

    const [member] = await db
      .select({ role: membership.role })
      .from(membership)
      .where(
        and(
          eq(membership.userId, assigneeUserId),
          eq(membership.agencyId, row.agencyId),
          eq(membership.status, 'active'),
        ),
      )
      .limit(1);

    if (!member) {
      throw new LeadTriageError('invalid', 'That person is not an active member of this agency');
    }

    const assignee: Actor = {
      userId: assigneeUserId,
      agencyId: row.agencyId,
      membershipRole: member.role as MembershipRole,
    };
    // Judged on the inbox, not on this lead: they do not hold it yet, and
    // being given it is exactly what will make it theirs.
    const inbox = { type: 'lead', agencyId: row.agencyId };
    if (!can(assignee, 'lead:read', inbox) || !maySeeKind(assignee, row)) {
      throw new LeadTriageError(
        'invalid',
        row.kind === 'offer'
          ? 'Private offers can only be assigned to an owner or admin'
          : 'That person cannot open the lead inbox',
      );
    }
  }

  const [updated] = await db
    .update(lead)
    .set({ assignedTo: assigneeUserId, updatedAt: sql`now()` })
    .where(
      and(
        eq(lead.id, row.id),
        eq(lead.agencyId, row.agencyId),
        assigneeUserId === null
          ? sql`true`
          : sql`exists (
              select 1 from ${membership}
              where ${membership.userId} = ${assigneeUserId}
                and ${membership.agencyId} = ${row.agencyId}
                and ${membership.status} = 'active'
            )`,
      ),
    )
    .returning({ id: lead.id, status: lead.status, assignedTo: lead.assignedTo });

  if (!updated) {
    throw new LeadTriageError('conflict', 'That person left the agency a moment ago — refresh and try again');
  }
  return { id: updated.id, status: updated.status as LeadStatus, assignedTo: updated.assignedTo };
}
