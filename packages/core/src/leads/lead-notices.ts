import { and, eq, inArray } from 'drizzle-orm';
import { lead, listingAgent, membership, property, user, type Db } from '@repo/db';
import { buildLeadNoticeEmail, type EmailTransport, type SenderIdentity } from '../email';
import { can, type Actor, type MembershipRole, type Resource } from '../permissions';

/**
 * Telling an agent a lead is waiting for them, by email.
 *
 * Two moments, and only two:
 *  - a NEW enquiry arrives on a listing → the agents named on that listing (or,
 *    when the listing has nobody active on it, the agency's owners and admins,
 *    so the lead never lands where nobody hears about it);
 *  - an admin ASSIGNS a lead to somebody → that person.
 *
 * Private offers are not sent here on arrival: `notify` in the web app's offer
 * action already mails owners and admins, and offers reach nobody else.
 *
 * ## Every recipient is judged by can()
 *
 * Each person is rebuilt as an Actor from their own membership and asked
 * `lead:read` on this lead (and `lead:read_offer` for an offer) — the same
 * question the console asks before showing it. An email is another way of
 * showing a lead, so it may only go where the screen would.
 *
 * ## Never in the way of the write
 *
 * Callers run these after the lead is recorded and outside any transaction
 * (the network call rule), and swallow what they throw: a lead that was saved
 * and not mailed is still in the inbox; a request that failed because Resend
 * did is a lost lead.
 */

export type NoticeDeps = {
  mailer: { sender: SenderIdentity; transport: EmailTransport };
  /** Origins of the two console hosts — admins work leads on one, agents on the other. */
  urls: { agentUrl: string; agencyUrl: string };
};

export type NoticeOutcome = { sent: number; failed: number };

type Facts = {
  id: string;
  agencyId: string;
  listingId: string | null;
  assignedTo: string | null;
  kind: 'enquiry' | 'inspection' | 'appraisal' | 'offer';
  name: string;
  email: string;
  phone: string | null;
  message: string | null;
  address: string | null;
};

type Person = { userId: string; email: string; name: string | null; role: MembershipRole };

async function loadFacts(db: Db, leadId: string): Promise<Facts | null> {
  const [row] = await db
    .select({
      id: lead.id,
      agencyId: lead.agencyId,
      listingId: lead.listingId,
      assignedTo: lead.assignedTo,
      kind: lead.kind,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      message: lead.message,
      address: property.formattedAddress,
    })
    .from(lead)
    .leftJoin(property, eq(property.id, lead.propertyId))
    .where(eq(lead.id, leadId))
    .limit(1);
  return (row as Facts | undefined) ?? null;
}

function actorFor(person: Person, facts: Facts): Actor {
  return {
    userId: person.userId,
    agencyId: facts.agencyId,
    membershipRole: person.role,
    ...(facts.listingId ? { listingAgentOf: [facts.listingId] } : {}),
  };
}

function resourceFor(facts: Facts, ownerId: string | null): Resource {
  return {
    type: 'lead',
    id: facts.id,
    agencyId: facts.agencyId,
    listingId: facts.listingId,
    ...(ownerId ? { ownerId } : {}),
  };
}

/**
 * May this person see this lead? `listingAgentOf` is only claimed for people
 * the query found ON the listing — see the callers — so it widens nothing.
 */
function maySee(actor: Actor, facts: Facts, ownerId: string | null): boolean {
  const resource = resourceFor(facts, ownerId);
  if (!can(actor, 'lead:read', resource)) return false;
  return facts.kind !== 'offer' || can(actor, 'lead:read_offer', resource);
}

/** Their own inbox, on their own host: the agency inbox for whoever may read all of it. */
function inboxUrl(actor: Actor, facts: Facts, urls: NoticeDeps['urls']): string {
  return can(actor, 'lead:read_all', { type: 'lead', agencyId: facts.agencyId })
    ? `${urls.agencyUrl}/leads`
    : `${urls.agentUrl}/my-leads`;
}

async function send(
  deps: NoticeDeps,
  facts: Facts,
  reason: 'new' | 'assigned',
  recipients: { person: Person; actor: Actor }[],
): Promise<NoticeOutcome> {
  const outcome: NoticeOutcome = { sent: 0, failed: 0 };
  const { sender, transport } = deps.mailer;

  for (const { person, actor } of recipients) {
    const message = buildLeadNoticeEmail({
      to: { email: person.email, ...(person.name ? { name: person.name } : {}) },
      from: sender.from,
      postalAddress: sender.postalAddress,
      reason,
      kind: facts.kind,
      propertyAddress: facts.address,
      person: { name: facts.name, email: facts.email, phone: facts.phone },
      message: facts.message,
      inboxUrl: inboxUrl(actor, facts, deps.urls),
    });
    const result = await transport.send(message);
    if (result.ok) outcome.sent += 1;
    else {
      outcome.failed += 1;
      // The lead id, never the recipient's address — this reaches logs.
      console.error(`[lead-notice] ${reason} notice for lead ${facts.id} not sent: ${result.error}`);
    }
  }
  return outcome;
}

/**
 * A new lead on a listing: mail the agents named on it.
 *
 * Active members of the lead's own agency only — a listing agent row outlives
 * a person leaving, and somebody who has left must stop hearing about leads.
 * With nobody active on the listing, the owners and admins hear instead.
 */
export async function notifyNewLead(db: Db, deps: NoticeDeps, leadId: string): Promise<NoticeOutcome> {
  const facts = await loadFacts(db, leadId);
  if (!facts || facts.kind === 'offer') return { sent: 0, failed: 0 };

  const personFields = {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: membership.role,
  };

  let people: Person[] = facts.listingId
    ? await db
        .select(personFields)
        .from(listingAgent)
        .innerJoin(user, eq(user.id, listingAgent.userId))
        .innerJoin(
          membership,
          and(
            eq(membership.userId, listingAgent.userId),
            eq(membership.agencyId, facts.agencyId),
            eq(membership.status, 'active'),
          ),
        )
        .where(eq(listingAgent.listingId, facts.listingId))
    : [];

  if (people.length === 0) {
    people = await db
      .select(personFields)
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .where(
        and(
          eq(membership.agencyId, facts.agencyId),
          eq(membership.status, 'active'),
          inArray(membership.role, ['owner', 'admin']),
        ),
      );
  }

  const recipients = people
    .map((person) => ({ person, actor: actorFor(person, facts) }))
    .filter(({ actor }) => maySee(actor, facts, facts.assignedTo));

  return send(deps, facts, 'new', recipients);
}

/**
 * A lead was assigned: mail the person it now belongs to.
 *
 * Skipped when the assigner took it themselves — telling somebody what they
 * just did is noise — and when the lead has moved on since (reassigned or
 * cleared before this ran), so a stale email never names the wrong owner.
 */
export async function notifyLeadAssigned(
  db: Db,
  deps: NoticeDeps,
  leadId: string,
  assigneeUserId: string,
  assignedBy: string,
): Promise<NoticeOutcome> {
  if (assigneeUserId === assignedBy) return { sent: 0, failed: 0 };

  const facts = await loadFacts(db, leadId);
  if (!facts || facts.assignedTo !== assigneeUserId) return { sent: 0, failed: 0 };

  const [person] = await db
    .select({ userId: user.id, email: user.email, name: user.name, role: membership.role })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(
        eq(membership.userId, assigneeUserId),
        eq(membership.agencyId, facts.agencyId),
        eq(membership.status, 'active'),
      ),
    )
    .limit(1);
  if (!person) return { sent: 0, failed: 0 };

  // Not a listing agent claim: they are judged as the lead's assignee.
  const actor: Actor = { userId: person.userId, agencyId: facts.agencyId, membershipRole: person.role };
  if (!maySee(actor, facts, facts.assignedTo)) return { sent: 0, failed: 0 };

  return send(deps, facts, 'assigned', [{ person, actor }]);
}
