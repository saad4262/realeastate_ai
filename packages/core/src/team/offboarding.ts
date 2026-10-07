import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  activity,
  agentSkill,
  appointment,
  assistantConversation,
  contact,
  emailBatch,
  integrationAccount,
  lead,
  listing,
  listingAgent,
  listingImport,
  membership,
  note,
  proposedAction,
  searchEmbedding,
  user,
  type Db,
  type DbOrTx,
} from '@repo/db';
import { can, type Actor, type MembershipRole } from '../permissions';
import { ACTIVE_STATUSES } from '../appointments/appointment-schema';
import { removeProviderItemAs, syncAppointment, type SyncDeps } from '../appointments/sync';
import { attachListingAgents } from '../listings/listing-agents';
import { decryptToken } from '../integrations/crypto';
import { adapterForTokens } from '../integrations/oauth';
import { assignContact } from '../contacts/write-contacts';
import { assignLead } from '../leads/triage-lead';
import type { IntegrationProvider } from '../integrations/providers';

/**
 * Removing a person from an agency (ADR 0030 §5–8). An owner/admin action
 * (`team:manage`; another OWNER needs `team:remove_owner`), never on yourself,
 * never the last owner. In this order — network never inside the transaction:
 *
 *  1. The admin MUST choose who receives the work, or "leave it for review"
 *     (decided Q1: no silent default). `offboardingPreview` gives the counts.
 *  2. While the leaver's tokens still work: delete their upcoming appointments'
 *     events from THEIR calendar and meetings on THEIR Zoom.
 *  3. One transaction: suspend the membership (restorable 30 days); move or
 *     flag their contacts, leads, upcoming appointments and listings; cancel
 *     their waiting assistant cards, prepared email batches and running
 *     imports; disable their skills; delete their assistant conversations;
 *     flag agency accounts they connected.
 *  4. Revoke (best effort) then delete their own integration tokens.
 *  5. Sync the moved appointments into the receiver's calendar/Zoom.
 *
 * Their written work (notes, sent mail, activity, dashboards) stays, with
 * their name — it belongs to the agency.
 */

export class OffboardError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'OffboardError';
  }
}

export const RESTORE_DAYS = 30;

export const offboardChoiceSchema = z.union([
  z.object({ receiver: z.string().uuid() }),
  z.object({ review: z.literal(true) }),
]);
export type OffboardChoice = z.infer<typeof offboardChoiceSchema>;

export type OffboardDeps = {
  /** Keys + provider seams for calendar/Zoom (removal and the receiver's sync). */
  sync?: SyncDeps | null;
  /** Revoke at the provider. Test seam; default: the provider's own revoke. */
  revoke?: (provider: IntegrationProvider, token: string) => Promise<void>;
};

const team = (agencyId: string) => ({ type: 'team', agencyId });
const NOT_FOUND = () => new OffboardError('not_found', 'That member was not found');
const WRITE_ROLES = new Set<MembershipRole>(['owner', 'admin', 'agent', 'assistant', 'property_manager']);

async function loadTarget(db: Db, actor: Actor, userId: string, status: 'active' | 'suspended') {
  if (!actor.agencyId || !can(actor, 'team:manage', team(actor.agencyId))) {
    throw new OffboardError('forbidden', 'Only an owner or admin can remove or restore members');
  }
  if (!z.string().uuid().safeParse(userId).success) throw NOT_FOUND();
  const [m] = await db
    .select({ id: membership.id, role: membership.role, status: membership.status, removedAt: membership.removedAt, name: user.name, email: user.email })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.userId, userId), eq(membership.agencyId, actor.agencyId), eq(membership.status, status)))
    .limit(1);
  if (!m) throw NOT_FOUND();
  if (userId === actor.userId) throw new OffboardError('forbidden', 'You cannot remove yourself');
  if (m.role === 'owner' && !can(actor, 'team:remove_owner', team(actor.agencyId))) {
    throw new OffboardError('forbidden', 'Only an owner can remove or restore another owner');
  }
  return { ...m, agencyId: actor.agencyId };
}

async function activeOwners(db: Db, agencyId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(membership)
    .where(and(eq(membership.agencyId, agencyId), eq(membership.status, 'active'), eq(membership.role, 'owner')));
  return Number(r?.n ?? 0);
}

export type OffboardPreview = {
  member: { userId: string; name: string | null; email: string; role: string };
  counts: {
    upcomingAppointments: number;
    contacts: number;
    leads: number;
    listings: number;
    onlyAgentListings: number;
    waitingCards: number;
    preparedBatches: number;
    runningImports: number;
    dashboards: number;
    ownAccounts: number;
    agencyAccountsTheyConnected: number;
  };
  /** Who may receive the work: active members who may write, not the leaver. */
  receivers: { userId: string; name: string }[];
};

/** What removing this person would touch — counts from SQL, one statement plus the receivers. */
export async function offboardingPreview(db: Db, actor: Actor, userId: string, now = new Date()): Promise<OffboardPreview> {
  const t = await loadTarget(db, actor, userId, 'active');
  const a = t.agencyId;
  const iso = now.toISOString();
  const [c] = await db.execute<Record<keyof OffboardPreview['counts'], number>>(sql`
    select
      (select count(*)::int from appointment where agency_id = ${a} and assigned_agent_id = ${userId} and status in ('scheduled', 'rescheduled') and starts_at > ${iso}) as "upcomingAppointments",
      (select count(*)::int from contact where agency_id = ${a} and assigned_to = ${userId}) as "contacts",
      (select count(*)::int from lead where agency_id = ${a} and assigned_to = ${userId}) as "leads",
      (select count(*)::int from listing_agent la join listing l on l.id = la.listing_id where l.agency_id = ${a} and la.user_id = ${userId}) as "listings",
      (select count(*)::int from listing_agent la join listing l on l.id = la.listing_id where l.agency_id = ${a} and la.user_id = ${userId}
         and not exists (select 1 from listing_agent o where o.listing_id = l.id and o.user_id <> ${userId})) as "onlyAgentListings",
      (select count(*)::int from proposed_action where agency_id = ${a} and user_id = ${userId} and status in ('proposed', 'scheduled')) as "waitingCards",
      (select count(*)::int from email_batch where agency_id = ${a} and user_id = ${userId} and status = 'prepared') as "preparedBatches",
      (select count(*)::int from listing_import where agency_id = ${a} and created_by = ${userId} and status in ('mapped', 'validating', 'validated', 'importing')) as "runningImports",
      (select count(*)::int from dashboard where agency_id = ${a} and created_by = ${userId} and archived_at is null) as "dashboards",
      (select count(*)::int from integration_account where agency_id = ${a} and owner_type = 'user' and owner_id = ${userId}) as "ownAccounts",
      (select count(*)::int from integration_account where agency_id = ${a} and owner_type = 'agency' and connected_by = ${userId}) as "agencyAccountsTheyConnected"
  `);
  const receivers = await db
    .select({ userId: membership.userId, role: membership.role, name: user.name, email: user.email })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.agencyId, a), eq(membership.status, 'active'), ne(membership.userId, userId)))
    .orderBy(asc(user.name));
  return {
    member: { userId, name: t.name, email: t.email, role: t.role },
    counts: Object.fromEntries(Object.entries(c ?? {}).map(([k, v]) => [k, Number(v)])) as OffboardPreview['counts'],
    receivers: receivers.filter((r) => WRITE_ROLES.has(r.role as MembershipRole)).map((r) => ({ userId: r.userId, name: r.name || r.email })),
  };
}

export type RemovalReport = {
  choice: 'receiver' | 'review';
  receiverId: string | null;
  moved: { contacts: number; leads: number; appointments: number; listings: number };
  flagged: { contacts: number; leads: number; appointments: number; listings: number };
  calendar: { removed: number; notRemoved: number };
  zoom: { removed: number; notRemoved: number; linkChanged: number };
  cancelled: { cards: number; batches: number; imports: number };
  skillsDisabled: number;
  conversationsDeleted: number;
  /** Search-index rows derived from their private notes (ADR 0031 §11). */
  privateSearchEmbeddingsDeleted: number;
  agencyAccountsFlagged: number;
  tokens: { deleted: number; revokeUnconfirmed: string[] };
  synced: number;
};

/**
 * Remove a member (ADR 0030 §5). `choice` is required: a receiving member, or
 * `{ review: true }` to leave the work unassigned in the "Needs an owner" queue.
 */
export async function removeMember(db: Db, actor: Actor, userId: string, rawChoice: unknown, deps: OffboardDeps = {}, now = new Date()): Promise<RemovalReport> {
  const t = await loadTarget(db, actor, userId, 'active');
  const agencyId = t.agencyId;
  const parsed = offboardChoiceSchema.safeParse(rawChoice);
  if (!parsed.success) throw new OffboardError('invalid', 'Choose who receives their work, or leave it for review');
  const receiverId = 'receiver' in parsed.data ? parsed.data.receiver : null;
  let receiverIsAdmin = false;
  if (receiverId) {
    if (receiverId === userId) throw new OffboardError('invalid', 'The person being removed cannot receive their own work');
    const [r] = await db
      .select({ role: membership.role })
      .from(membership)
      .where(and(eq(membership.userId, receiverId), eq(membership.agencyId, agencyId), eq(membership.status, 'active')))
      .limit(1);
    if (!r || !WRITE_ROLES.has(r.role as MembershipRole)) throw new OffboardError('invalid', 'That person cannot receive work in this agency');
    receiverIsAdmin = r.role === 'owner' || r.role === 'admin';
  }
  if (t.role === 'owner' && (await activeOwners(db, agencyId)) <= 1) {
    throw new OffboardError('conflict', 'The agency’s last owner cannot be removed');
  }

  const report: RemovalReport = {
    choice: receiverId ? 'receiver' : 'review',
    receiverId,
    moved: { contacts: 0, leads: 0, appointments: 0, listings: 0 },
    flagged: { contacts: 0, leads: 0, appointments: 0, listings: 0 },
    calendar: { removed: 0, notRemoved: 0 },
    zoom: { removed: 0, notRemoved: 0, linkChanged: 0 },
    cancelled: { cards: 0, batches: 0, imports: 0 },
    skillsDisabled: 0,
    conversationsDeleted: 0,
    privateSearchEmbeddingsDeleted: 0,
    agencyAccountsFlagged: 0,
    tokens: { deleted: 0, revokeUnconfirmed: [] },
    synced: 0,
  };

  // ── 2. Network, while their access still works: their calendar events and their own Zoom meetings.
  const leaver: Actor = { userId, agencyId, membershipRole: t.role as MembershipRole };
  const upcoming = await db
    .select({
      id: appointment.id,
      contactId: appointment.contactId,
      eventId: appointment.externalCalendarId,
      calendarAccountId: appointment.externalCalendarAccountId,
      calendarState: appointment.calendarSyncState,
      meetingId: appointment.zoomMeetingId,
      zoomAccountId: appointment.zoomAccountId,
      zoomOwnerType: integrationAccount.ownerType,
      zoomOwnerId: integrationAccount.ownerId,
    })
    .from(appointment)
    .leftJoin(integrationAccount, eq(integrationAccount.id, appointment.zoomAccountId))
    .where(
      and(
        eq(appointment.agencyId, agencyId),
        eq(appointment.assignedAgentId, userId),
        inArray(appointment.status, [...ACTIVE_STATUSES]),
        gt(appointment.startsAt, now),
      ),
    );
  const clearedEvents: string[] = [];
  const clearedMeetings: { id: string; contactId: string }[] = [];
  for (const a of upcoming) {
    if (a.eventId && a.calendarAccountId && a.calendarState !== 'removed') {
      try {
        if (!deps.sync) throw new Error('integrations not set up');
        await removeProviderItemAs(db, deps.sync, leaver, { kind: 'calendar', accountId: a.calendarAccountId, eventId: a.eventId });
        report.calendar.removed += 1;
      } catch {
        report.calendar.notRemoved += 1; // their grant is gone already: "they may still see it"
      }
      clearedEvents.push(a.id);
    }
    // Only a meeting on the LEAVER's own Zoom moves; one on the agency's Zoom is the agency's.
    if (a.meetingId && a.zoomAccountId && a.zoomOwnerType === 'user' && a.zoomOwnerId === userId) {
      try {
        if (!deps.sync) throw new Error('integrations not set up');
        await removeProviderItemAs(db, deps.sync, leaver, { kind: 'zoom', accountId: a.zoomAccountId, meetingId: a.meetingId });
        report.zoom.removed += 1;
      } catch {
        report.zoom.notRemoved += 1;
      }
      clearedMeetings.push({ id: a.id, contactId: a.contactId });
    }
  }

  // ── 3. One transaction.
  const movedAppointments = await db.transaction(async (tx) => {
    const [suspended] = await tx
      .update(membership)
      .set({ status: 'suspended', removedAt: now, removedBy: actor.userId, updatedAt: sql`now()` })
      .where(and(eq(membership.id, t.id), eq(membership.status, 'active')))
      .returning({ id: membership.id });
    if (!suspended) throw new OffboardError('conflict', 'That member was removed a moment ago');
    if (t.role === 'owner' && (await activeOwners(tx as unknown as Db, agencyId)) < 1) {
      throw new OffboardError('conflict', 'The agency’s last owner cannot be removed');
    }
    const flag = receiverId ? null : now;

    const contacts = await tx
      .update(contact)
      .set({ assignedTo: receiverId, needsOwnerAt: flag, updatedAt: sql`now()` })
      .where(and(eq(contact.agencyId, agencyId), eq(contact.assignedTo, userId)))
      .returning({ id: contact.id });
    if (contacts.length) {
      await tx.insert(activity).values(
        contacts.map((c) => ({ agencyId, contactId: c.id, kind: 'owner_left', actorId: actor.userId, payload: { from: userId, to: receiverId }, occurredAt: now })),
      );
    }
    // A private offer goes only to an owner or admin (the lead rules): to an agent receiver
    // it is left unassigned, in the queue, instead.
    const leads = await tx
      .update(lead)
      .set({ assignedTo: receiverId, needsOwnerAt: flag, updatedAt: sql`now()` })
      .where(and(eq(lead.agencyId, agencyId), eq(lead.assignedTo, userId), receiverIsAdmin || !receiverId ? sql`true` : ne(lead.kind, 'offer')))
      .returning({ id: lead.id });
    const offersHeld = receiverId && !receiverIsAdmin
      ? await tx
          .update(lead)
          .set({ assignedTo: null, needsOwnerAt: now, updatedAt: sql`now()` })
          .where(and(eq(lead.agencyId, agencyId), eq(lead.assignedTo, userId), eq(lead.kind, 'offer')))
          .returning({ id: lead.id })
      : [];

    const upcomingIds = upcoming.map((a) => a.id);
    if (upcomingIds.length) {
      await tx
        .update(appointment)
        .set({ assignedAgentId: receiverId, needsOwnerAt: flag, updatedAt: sql`now()` })
        .where(inArray(appointment.id, upcomingIds));
    }
    if (clearedEvents.length) {
      await tx
        .update(appointment)
        .set({ externalCalendarId: null, externalCalendarAccountId: null, externalCalendarEtag: null, calendarSyncState: receiverId ? 'pending' : null, calendarSyncError: null, calendarConflict: null })
        .where(inArray(appointment.id, clearedEvents));
    }
    if (clearedMeetings.length) {
      await tx
        .update(appointment)
        // The old invitation carried the old link: it no longer counts as sent, so a new one can go.
        .set({ zoomMeetingId: null, zoomAccountId: null, meetingUrl: null, zoomSyncState: receiverId ? 'pending' : null, zoomSyncError: null, invitationSentAt: null })
        .where(inArray(appointment.id, clearedMeetings.map((m) => m.id)));
      await tx.insert(activity).values(
        clearedMeetings.map((m) => ({ agencyId, contactId: m.contactId, kind: 'zoom_link_changed', actorId: actor.userId, payload: { appointmentId: m.id }, occurredAt: now })),
      );
    }

    // Listings: their listing_agent rows go; a listing left with nobody gets the receiver, or is flagged.
    const theirs = await tx
      .select({ listingId: listingAgent.listingId })
      .from(listingAgent)
      .innerJoin(listing, eq(listing.id, listingAgent.listingId))
      .where(and(eq(listing.agencyId, agencyId), eq(listingAgent.userId, userId)));
    const listingIds = theirs.map((l) => l.listingId);
    let orphanIds: string[] = [];
    if (listingIds.length) {
      await tx.delete(listingAgent).where(and(inArray(listingAgent.listingId, listingIds), eq(listingAgent.userId, userId)));
      const orphans = await tx
        .select({ id: listing.id })
        .from(listing)
        .where(and(inArray(listing.id, listingIds), notExists(tx.select({ x: sql`1` }).from(listingAgent).where(eq(listingAgent.listingId, listing.id)))));
      orphanIds = orphans.map((o) => o.id);
      for (const id of orphanIds) {
        if (receiverId) await attachListingAgents(tx, agencyId, id, [receiverId]);
      }
      if (!receiverId && orphanIds.length) {
        await tx.update(listing).set({ needsOwnerAt: now, updatedAt: sql`now()` }).where(inArray(listing.id, orphanIds));
      }
    }

    const cards = await tx
      .update(proposedAction)
      .set({ status: 'cancelled', error: 'The person was removed from the agency', decidedAt: now, decidedBy: actor.userId, updatedAt: sql`now()` })
      .where(and(eq(proposedAction.agencyId, agencyId), eq(proposedAction.userId, userId), inArray(proposedAction.status, ['proposed', 'scheduled'])))
      .returning({ id: proposedAction.id, contactId: proposedAction.contactId, tool: proposedAction.tool });
    const cardContacts = cards.filter((c) => c.contactId);
    if (cardContacts.length) {
      await tx.insert(activity).values(
        cardContacts.map((c) => ({ agencyId, contactId: c.contactId!, kind: 'assistant_cancelled', actorId: actor.userId, payload: { actionId: c.id, tool: c.tool, reason: 'member_removed' }, occurredAt: now })),
      );
    }
    const batches = await tx
      .update(emailBatch)
      .set({ status: 'cancelled', updatedAt: sql`now()` })
      .where(and(eq(emailBatch.agencyId, agencyId), eq(emailBatch.userId, userId), eq(emailBatch.status, 'prepared')))
      .returning({ id: emailBatch.id });
    const imports = await tx
      .update(listingImport)
      .set({ status: 'cancelled', finishedAt: now, error: 'The person who started it was removed from the agency', updatedAt: sql`now()` })
      .where(and(eq(listingImport.agencyId, agencyId), eq(listingImport.createdBy, userId), inArray(listingImport.status, ['mapped', 'validating', 'validated', 'importing'])))
      .returning({ id: listingImport.id });
    const skills = await tx
      .update(agentSkill)
      .set({ enabled: false, updatedAt: sql`now()` })
      .where(and(eq(agentSkill.agencyId, agencyId), eq(agentSkill.userId, userId), eq(agentSkill.enabled, true)))
      .returning({ id: agentSkill.id });
    const convs = await tx
      .delete(assistantConversation)
      .where(and(eq(assistantConversation.agencyId, agencyId), eq(assistantConversation.userId, userId)))
      .returning({ id: assistantConversation.id });
    // Their private notes stay with the agency (admins read them); nothing derived from them may
    // stay in the search index (ADR 0031 §11) — none is made by policy, this keeps it that way.
    const privateEmbeddings = await tx
      .delete(searchEmbedding)
      .where(
        and(
          eq(searchEmbedding.agencyId, agencyId),
          eq(searchEmbedding.sourceKind, 'note'),
          inArray(
            searchEmbedding.sourceId,
            tx.select({ id: note.id }).from(note).where(and(eq(note.agencyId, agencyId), eq(note.authorId, userId), eq(note.isPrivate, true))),
          ),
        ),
      )
      .returning({ id: searchEmbedding.id });
    const flagged = await tx
      .update(integrationAccount)
      .set({ connectorLeftAt: now, updatedAt: sql`now()` })
      .where(and(eq(integrationAccount.agencyId, agencyId), eq(integrationAccount.ownerType, 'agency'), eq(integrationAccount.connectedBy, userId)))
      .returning({ id: integrationAccount.id });

    const key = receiverId ? 'moved' : 'flagged';
    report[key].contacts = contacts.length;
    report[key].leads = leads.length;
    report.flagged.leads += offersHeld.length;
    report[key].appointments = upcomingIds.length;
    report[key].listings = orphanIds.length;
    report.zoom.linkChanged = clearedMeetings.length;
    report.cancelled = { cards: cards.length, batches: batches.length, imports: imports.length };
    report.skillsDisabled = skills.length;
    report.conversationsDeleted = convs.length;
    report.privateSearchEmbeddingsDeleted = privateEmbeddings.length;
    report.agencyAccountsFlagged = flagged.length;
    return receiverId ? upcomingIds : [];
  });

  // ── 4. Their own integration tokens: revoke (best effort), then delete.
  const accounts = await db
    .select({ id: integrationAccount.id, provider: integrationAccount.provider, access: integrationAccount.accessTokenEnc, refresh: integrationAccount.refreshTokenEnc })
    .from(integrationAccount)
    .where(and(eq(integrationAccount.agencyId, agencyId), eq(integrationAccount.ownerType, 'user'), eq(integrationAccount.ownerId, userId)));
  const keys = deps.sync?.keys ?? null;
  for (const acc of accounts) {
    const provider = acc.provider as IntegrationProvider;
    let confirmed = false;
    try {
      if (keys && acc.access) {
        const access = decryptToken(acc.access, { rowId: acc.id, column: 'access_token' }, keys);
        const refresh = acc.refresh ? decryptToken(acc.refresh, { rowId: acc.id, column: 'refresh_token' }, keys) : null;
        const token = provider === 'zoom' ? access : (refresh ?? access);
        if (deps.revoke) await deps.revoke(provider, token);
        else {
          const adapter = adapterForTokens(provider, access, deps.sync?.env ?? process.env);
          if (!adapter) throw new Error('no adapter');
          await adapter.revoke(token);
        }
        confirmed = true;
      }
    } catch {
      confirmed = false;
    }
    if (!confirmed) report.tokens.revokeUnconfirmed.push(provider);
  }
  if (accounts.length) {
    const gone = await db.delete(integrationAccount).where(inArray(integrationAccount.id, accounts.map((a) => a.id))).returning({ id: integrationAccount.id });
    report.tokens.deleted = gone.length;
  }

  // ── 5. Into the receiver's calendar / Zoom.
  if (deps.sync) {
    for (const id of movedAppointments) {
      const out = await syncAppointment(db, deps.sync, id).catch(() => null);
      if (out?.ran) report.synced += 1;
    }
  }

  await db.update(membership).set({ removalReport: report }).where(eq(membership.id, t.id));
  return report;
}

/** Bring back a removal made within the last 30 days. Tokens do not come back; moved work stays moved. */
export async function restoreMember(db: Db, actor: Actor, userId: string, now = new Date()): Promise<void> {
  const t = await loadTarget(db, actor, userId, 'suspended');
  if (!t.removedAt || new Date(t.removedAt).getTime() < now.getTime() - RESTORE_DAYS * 86_400_000) {
    throw new OffboardError('conflict', `Only a removal from the last ${RESTORE_DAYS} days can be undone`);
  }
  try {
    await db
      .update(membership)
      .set({ status: 'active', removedAt: null, removedBy: null, updatedAt: sql`now()` })
      .where(and(eq(membership.id, t.id), eq(membership.status, 'suspended')));
  } catch (err) {
    // membership_one_active_idx: they have joined another agency since.
    if (/membership_one_active_idx|duplicate key/i.test(String((err as { message?: string }).message))) {
      throw new OffboardError('conflict', 'This person now belongs to another agency, so they cannot be restored here');
    }
    throw err;
  }
}

export type RemovedMember = { userId: string; name: string; removedAt: Date; mayRestore: boolean; report: RemovalReport | null };

/** People removed from this agency, newest first, with whether Undo is still possible. */
export async function listRemovedMembers(db: Db, actor: Actor, now = new Date()): Promise<RemovedMember[]> {
  if (!actor.agencyId || !can(actor, 'team:manage', team(actor.agencyId))) return [];
  const rows = await db
    .select({ userId: membership.userId, role: membership.role, name: user.name, email: user.email, removedAt: membership.removedAt, report: membership.removalReport })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.agencyId, actor.agencyId), eq(membership.status, 'suspended'), isNotNull(membership.removedAt)))
    .orderBy(desc(membership.removedAt))
    .limit(50);
  const cutoff = now.getTime() - RESTORE_DAYS * 86_400_000;
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name || r.email,
    removedAt: new Date(r.removedAt!),
    mayRestore: new Date(r.removedAt!).getTime() >= cutoff && (r.role !== 'owner' || can(actor, 'team:remove_owner', team(actor.agencyId!))),
    report: (r.report as RemovalReport | null) ?? null,
  }));
}

export type NeedsOwnerItem = { kind: 'contact' | 'lead' | 'appointment' | 'listing'; id: string; label: string; since: Date };

/**
 * The "Needs an owner" queue (ADR 0030 §7, decided Q6: owners and admins):
 * work flagged by an offboarding that nobody has taken yet. Something assigned
 * by any other screen drops out on its own (the owner column is set again).
 */
export async function listNeedsOwner(db: Db, actor: Actor): Promise<NeedsOwnerItem[]> {
  if (!actor.agencyId || !can(actor, 'team:manage', team(actor.agencyId))) return [];
  const a = actor.agencyId;
  const rows = await db.execute<{ kind: NeedsOwnerItem['kind']; id: string; label: string; since: string }>(sql`
    select 'contact' as kind, id, name as label, needs_owner_at as since from contact
      where agency_id = ${a} and needs_owner_at is not null and assigned_to is null
    union all
    select 'lead', id, coalesce(name, email, 'Enquiry'), needs_owner_at from lead
      where agency_id = ${a} and needs_owner_at is not null and assigned_to is null
    union all
    select 'appointment', id, title, needs_owner_at from appointment
      where agency_id = ${a} and needs_owner_at is not null and assigned_agent_id is null and status in ('scheduled', 'rescheduled')
    union all
    select 'listing', l.id, coalesce(l.headline, 'Listing'), l.needs_owner_at from listing l
      where l.agency_id = ${a} and l.needs_owner_at is not null
        and not exists (select 1 from listing_agent la where la.listing_id = l.id)
    order by since desc
    limit 500`);
  return rows.map((r) => ({ kind: r.kind, id: r.id, label: r.label, since: new Date(r.since) }));
}

/**
 * Give one queued item an owner. Contacts and leads go through their own
 * screens' assign functions (which ask `contact:assign` / `lead:assign`);
 * appointments ask `appointment:assign` and are then synced into the new
 * agent's calendar; listings get the member as their listing agent.
 */
export async function assignNeedsOwner(
  db: Db,
  actor: Actor,
  item: { kind: NeedsOwnerItem['kind']; id: string; userId: string },
  deps: OffboardDeps = {},
): Promise<void> {
  if (!actor.agencyId || !can(actor, 'team:manage', team(actor.agencyId))) {
    throw new OffboardError('forbidden', 'Only an owner or admin can give work an owner');
  }
  const agencyId = actor.agencyId;
  if (!z.string().uuid().safeParse(item.id).success || !z.string().uuid().safeParse(item.userId).success) throw NOT_FOUND();
  const [member] = await db
    .select({ role: membership.role })
    .from(membership)
    .where(and(eq(membership.userId, item.userId), eq(membership.agencyId, agencyId), eq(membership.status, 'active')))
    .limit(1);
  if (!member || !WRITE_ROLES.has(member.role as MembershipRole)) throw new OffboardError('invalid', 'That person cannot take work in this agency');

  if (item.kind === 'contact') {
    await assignContact(db, actor, item.id, item.userId);
    await db.update(contact).set({ needsOwnerAt: null }).where(and(eq(contact.id, item.id), eq(contact.agencyId, agencyId)));
    return;
  }
  if (item.kind === 'lead') {
    await assignLead(db, actor, item.id, item.userId);
    await db.update(lead).set({ needsOwnerAt: null }).where(and(eq(lead.id, item.id), eq(lead.agencyId, agencyId)));
    return;
  }
  if (item.kind === 'appointment') {
    if (!can(actor, 'appointment:assign', { type: 'appointment', agencyId })) throw new OffboardError('forbidden', 'You may not assign appointments');
    const done = await db
      .update(appointment)
      .set({ assignedAgentId: item.userId, needsOwnerAt: null, calendarSyncState: 'pending', updatedAt: sql`now()` })
      .where(and(eq(appointment.id, item.id), eq(appointment.agencyId, agencyId), isNull(appointment.assignedAgentId), gte(appointment.startsAt, new Date(0))))
      .returning({ id: appointment.id });
    if (!done.length) throw NOT_FOUND();
    if (deps.sync) await syncAppointment(db, deps.sync, item.id).catch(() => null);
    return;
  }
  if (!can(actor, 'listing:publish', { type: 'listing', agencyId })) throw new OffboardError('forbidden', 'You may not change listings');
  await db.transaction(async (tx) => {
    const [l] = await tx.select({ id: listing.id }).from(listing).where(and(eq(listing.id, item.id), eq(listing.agencyId, agencyId))).limit(1);
    if (!l) throw NOT_FOUND();
    await attachListingAgents(tx, agencyId, l.id, [item.userId], { replace: true });
    await tx.update(listing).set({ needsOwnerAt: null, updatedAt: sql`now()` }).where(eq(listing.id, l.id));
  });
}

/**
 * For a signed-in person with no active membership: the agency that removed
 * them, and when (ADR 0030 §5.5) — so the console can say "You no longer have
 * access to <agency>" instead of offering to register a new agency. Null for
 * anyone who is an active member somewhere, or was never removed.
 */
export async function removedFromAgency(db: DbOrTx, userId: string): Promise<{ agencyName: string; removedAt: Date } | null> {
  if (!z.string().uuid().safeParse(userId).success) return null;
  const rows = await db.execute<{ name: string; removed_at: string }>(sql`
    select a.name, m.removed_at
    from membership m join agency a on a.id = m.agency_id
    where m.user_id = ${userId} and m.status = 'suspended' and m.removed_at is not null
      and not exists (select 1 from membership x where x.user_id = ${userId} and x.status = 'active')
    order by m.removed_at desc
    limit 1`);
  const r = rows[0];
  return r ? { agencyName: r.name, removedAt: new Date(r.removed_at) } : null;
}
