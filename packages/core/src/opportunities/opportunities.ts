import { and, desc, eq, sql } from 'drizzle-orm';
import { agency, contact, opportunity, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { visibleContactIdsSql } from '../contacts/visibility';
import { describeOpportunity, OPPORTUNITY_KIND_LABELS } from './describe';
import type { OpportunityKind } from './detectors';

/**
 * A person's open opportunities (ADR 0054 §6): their own only (`opportunity:read`), and only while
 * they can still see the contact — a contact reassigned since the scan drops off their list.
 */

export class OpportunityError extends Error {
  readonly code: 'not_found' | 'forbidden';
  constructor(code: OpportunityError['code'], message: string) {
    super(message);
    this.name = 'OpportunityError';
    this.code = code;
  }
}

export type OpportunityView = {
  id: string;
  kind: OpportunityKind;
  label: string;
  title: string;
  detail: string;
  /** The question for the assistant's box. */
  ask: string;
  contactId: string | null;
  contactName: string | null;
  threadId: string | null;
  listingId: string | null;
  createdAt: Date;
};

export type OpportunityList = { rows: OpportunityView[]; total: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mine(actor: Actor) {
  return { type: 'opportunity', agencyId: actor.agencyId ?? undefined, ownerId: actor.userId };
}

function scope(actor: Actor) {
  return and(
    eq(opportunity.agencyId, actor.agencyId as string),
    eq(opportunity.userId, actor.userId),
    eq(opportunity.status, 'open'),
    sql`(${opportunity.contactId} is null or ${opportunity.contactId} in (${visibleContactIdsSql(actor)}))`,
  );
}

/** The newest `limit` open ones and how many are open in all. One statement. */
export async function listOpportunities(db: Db, actor: Actor, opts: { limit?: number } = {}): Promise<OpportunityList> {
  if (!actor.agencyId || !can(actor, 'opportunity:read', mine(actor))) return { rows: [], total: 0 };
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
  const rows = await db
    .select({
      id: opportunity.id,
      kind: opportunity.kind,
      facts: opportunity.facts,
      contactId: opportunity.contactId,
      contactName: contact.name,
      threadId: opportunity.threadId,
      listingId: opportunity.listingId,
      createdAt: opportunity.createdAt,
      timeZone: agency.timeZone,
      total: sql<number>`count(*) over ()`,
    })
    .from(opportunity)
    .innerJoin(agency, eq(agency.id, opportunity.agencyId))
    .leftJoin(contact, eq(contact.id, opportunity.contactId))
    .where(scope(actor))
    .orderBy(desc(opportunity.createdAt), desc(opportunity.id))
    .limit(limit);
  return {
    total: Number(rows[0]?.total ?? 0),
    rows: rows.map((r) => {
      const text = describeOpportunity(r.kind, r.facts as Record<string, unknown>, r.timeZone || 'Australia/Sydney');
      return {
        id: r.id,
        kind: r.kind as OpportunityKind,
        label: OPPORTUNITY_KIND_LABELS[r.kind as OpportunityKind] ?? 'Opportunity',
        ...text,
        contactId: r.contactId,
        contactName: r.contactName,
        threadId: r.threadId,
        listingId: r.listingId,
        createdAt: r.createdAt,
      };
    }),
  };
}

/** Done or dismissed — the person's own, still open. Anything else is "not found". */
export async function resolveOpportunity(db: Db, actor: Actor, id: string, status: 'done' | 'dismissed'): Promise<void> {
  if (!actor.agencyId || !UUID.test(id)) throw new OpportunityError('not_found', 'That opportunity was not found');
  if (!can(actor, 'opportunity:update', mine(actor))) throw new OpportunityError('forbidden', 'You cannot change this opportunity');
  const changed = await db
    .update(opportunity)
    .set({ status, resolvedAt: sql`now()` })
    .where(and(eq(opportunity.id, id), eq(opportunity.agencyId, actor.agencyId), eq(opportunity.userId, actor.userId), eq(opportunity.status, 'open')))
    .returning({ id: opportunity.id });
  if (!changed.length) throw new OpportunityError('not_found', 'That opportunity was not found');
}
