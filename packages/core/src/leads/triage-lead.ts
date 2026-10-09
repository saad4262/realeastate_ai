import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { activity, agentProfile, contact, lead, leadHandover, leadStatusEnum, membership, user, type DbOrTx } from '@repo/db';
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
  contactId: string | null;
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
      contactId: lead.contactId,
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
  /**
   * On a reassignment: whether the lead's contact went with it — only when it
   * was the previous agent's or nobody's (the client's rule, 2026-10-07). The
   * screen says so; a contact that is a third agent's stays theirs.
   */
  contactMoved?: boolean;
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
  /**
   * From the console assistant's card (ADR 0025 amendment, 2026-10-09): the
   * same reassignment, marked `via: 'assistant'` on the timeline, and refused
   * if the lead changed hands since the card showed who had it (`expectedFrom`).
   */
  opts: { via?: 'assistant'; expectedFrom?: string | null } = {},
): Promise<TriagedLead> {
  const row = await loadLead(db, actor, leadId);
  if (!maySee(actor, row)) throw NOT_FOUND();
  if (!can(actor, 'lead:assign', resourceFor(row))) {
    throw new LeadTriageError('forbidden', 'Only an agency admin can assign leads');
  }
  const guarded = opts.expectedFrom !== undefined;
  if (guarded && row.assignedTo !== opts.expectedFrom) {
    throw new LeadTriageError('conflict', 'This lead was given to someone else after the card was made — nothing was changed. Ask again.');
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

  return db.transaction(async (tx) => {
  const [updated] = await tx
    .update(lead)
    .set({ assignedTo: assigneeUserId, updatedAt: sql`now()` })
    .where(
      and(
        eq(lead.id, row.id),
        eq(lead.agencyId, row.agencyId),
        ...(guarded ? [sql`${lead.assignedTo} is not distinct from ${opts.expectedFrom ?? null}`] : []),
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
    throw new LeadTriageError(
      'conflict',
      guarded ? 'This lead changed after the card was made, or that person left the agency — nothing was changed. Ask again.' : 'That person left the agency a moment ago — refresh and try again',
    );
  }
  const from = row.assignedTo;
  const to = updated.assignedTo;
  if (from === to) return { id: updated.id, status: updated.status as LeadStatus, assignedTo: to };

  // The client's rule (2026-10-07). The contact follows the lead when it was the previous
  // agent's or nobody's — never a third agent's; offers never move a contact (they never
  // show one either).
  let contactMoved = false;
  if (row.contactId && row.kind !== 'offer' && to) {
    const moved = await tx
      .update(contact)
      .set({ assignedTo: to, updatedAt: sql`now()` })
      .where(
        and(
          eq(contact.id, row.contactId),
          eq(contact.agencyId, row.agencyId),
          from ? sql`(${contact.assignedTo} is null or ${contact.assignedTo} = ${from})` : isNull(contact.assignedTo),
        ),
      )
      .returning({ id: contact.id });
    contactMoved = moved.length > 0;
    if (contactMoved) {
      await tx.insert(activity).values({
        agencyId: row.agencyId,
        contactId: row.contactId,
        kind: 'contact_assigned',
        actorType: 'user',
        actorId: actor.userId,
        payload: { from, to, via: 'lead', ...(opts.via ? { by: opts.via } : {}) },
      });
    }
  }
  // The agent it was taken from keeps a note, and nothing else (`listReassignedAway`).
  if (from) {
    await tx.insert(leadHandover).values({ agencyId: row.agencyId, leadId: row.id, fromUserId: from, toUserId: to, byUserId: actor.userId, contactMoved });
  }
  if (row.contactId) {
    const names = await tx
      .select({ id: user.id, name: sql<string>`coalesce(${agentProfile.displayName}, ${user.name}, ${user.email})` })
      .from(user)
      .leftJoin(agentProfile, eq(agentProfile.userId, user.id))
      .where(sql`${user.id} in (${sql.join([from, to].filter((x): x is string => Boolean(x)).map((x) => sql`${x}`), sql`, `)})`);
    const nameOf = (id: string | null) => (id ? (names.find((n) => n.id === id)?.name ?? null) : null);
    // Who, when, from and to — shown only to owners/admins and the lead's current assignee.
    await tx.insert(activity).values({
      agencyId: row.agencyId,
      contactId: row.contactId,
      kind: 'lead_assigned',
      actorType: 'user',
      actorId: actor.userId,
      payload: { leadId: row.id, from, to, fromName: nameOf(from), toName: nameOf(to), contactMoved, ...(opts.via ? { via: opts.via } : {}) },
    });
  }
  return { id: updated.id, status: updated.status as LeadStatus, assignedTo: to, contactMoved };
  });
}
