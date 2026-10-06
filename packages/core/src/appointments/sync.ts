import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { appointment, contact, membership, property, type CalendarConflict, type DbOrTx } from '@repo/db';
import type { Actor, MembershipRole } from '../permissions';
import { formatAddress } from '../listings/listing-schema';
import {
  googleCalendarApi,
  stubCalendarApi,
  type CalendarApi,
  type CalendarEventInput,
} from '../integrations/google-calendar';
import { IntegrationError, resolveIntegration } from '../integrations/accounts';
import { tokenKeysFromEnv, type TokenKeys } from '../integrations/crypto';
import { isStubToken, stubEnabled } from '../integrations/oauth';
import { ProviderError, type Fetch } from '../integrations/provider-http';
import { markUsed, withAccessToken } from '../integrations/tokens';
import { stubZoomApi, zoomMeetingsApi, type ZoomApi, type ZoomMeetingInput } from '../integrations/zoom-meetings';
import { ACTIVE_STATUSES, APPOINTMENT_TYPE_LABELS, type AppointmentStatus, type AppointmentType } from './appointment-schema';

/**
 * Mirroring appointments into Google Calendar and Zoom (Phase 3b, ADR 0020).
 *
 * Our `appointment` row is the source of truth. After every change the
 * console calls `syncAppointment`, which makes the outside match it:
 *   - Zoom (type zoom, no link of their own): create the meeting on the
 *     assigned agent's own Zoom, else the agency's; move it on reschedule;
 *     delete it on cancel. Done first, so the calendar event carries the link.
 *   - Google Calendar (the assigned agent's own, if connected): the event is
 *     created / moved / marked done / deleted to match. No attendees, so
 *     Google never emails the contact.
 *
 * It acts AS the assigned agent: their connection, chosen by
 * `resolveIntegration` for them, used through `withAccessToken`, which asks
 * can('integration:use') for them. Nobody else's connection is ever looked
 * at — not the person who pressed the button, if that was an admin.
 *
 * A double submit cannot create twice: one run at a time holds the row
 * (`sync_claimed_at`, a guarded update), and the Google event id is derived
 * from the appointment id. If the row changed while a run was talking to
 * Google, it goes round again.
 *
 * Provider calls happen outside any transaction; every write is one
 * statement and never touches `updated_at` (that is the user's change clock).
 */

export type SyncDeps = {
  keys: TokenKeys | null;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  now?: () => Date;
  /** Tests and the smoke suite inject fakes; otherwise chosen per token (stub or real). */
  calendarApi?: CalendarApi;
  zoomApi?: ZoomApi;
};

/** What the console and the cron pass in: the server's token key, the real network. */
export function syncDepsFromEnv(env: NodeJS.ProcessEnv = process.env): SyncDeps {
  let keys: TokenKeys | null = null;
  try {
    keys = tokenKeysFromEnv(env);
  } catch {
    keys = null; // a malformed key is refused at startup; here it means "cannot sync"
  }
  return { keys, env };
}

export const SYNC_STATES = ['pending', 'synced', 'failed', 'conflict', 'removed'] as const;
export type SyncState = (typeof SYNC_STATES)[number];

/** A claim older than this is a crashed run; the next one may take over. */
export const CLAIM_STALE_MS = 2 * 60 * 1000;
const MAX_ROUNDS = 3;

export type SyncOutcome = {
  ran: boolean;
  calendar: SyncState | null;
  zoom: SyncState | null;
};

function calendarApiFor(deps: SyncDeps, token: string): CalendarApi {
  if (deps.calendarApi) return deps.calendarApi;
  if (isStubToken(token)) {
    if (!stubEnabled(deps.env ?? process.env)) throw new ProviderError('failed', 'The pretend provider is off on this server');
    return stubCalendarApi();
  }
  return googleCalendarApi(deps.fetch ?? fetch);
}

function zoomApiFor(deps: SyncDeps, token: string): ZoomApi {
  if (deps.zoomApi) return deps.zoomApi;
  if (isStubToken(token)) {
    if (!stubEnabled(deps.env ?? process.env)) throw new ProviderError('failed', 'The pretend provider is off on this server');
    return stubZoomApi();
  }
  return zoomMeetingsApi(deps.fetch ?? fetch);
}

/** A sentence for the agent from whatever went wrong — never a token, never a provider body. */
export function syncErrorMessage(provider: 'Google Calendar' | 'Zoom', err: unknown): string {
  if (err instanceof IntegrationError) {
    if (err.code === 'expired') return `${provider} needs reconnecting — open Integrations, reconnect, then Retry.`;
    if (err.code === 'not_found') return `${provider} is no longer connected for this agent.`;
    return `${provider}: ${err.message}`;
  }
  if (err instanceof ProviderError) {
    if (err.kind === 'rate_limited') return `${provider} is busy — Retry in a minute.`;
    if (err.kind === 'unauthorized') return `${provider} refused the connection — reconnect, then Retry.`;
    return `${provider} did not accept the change (${err.message}). Retry.`;
  }
  return `${provider} could not be reached. Retry.`;
}

type Loaded = {
  id: string;
  agencyId: string;
  contactName: string;
  title: string;
  type: AppointmentType;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  location: string | null;
  meetingUrl: string | null;
  propertyAddress: string | null;
  assignedAgentId: string | null;
  agentRole: MembershipRole | null;
  externalCalendarId: string | null;
  externalCalendarAccountId: string | null;
  calendarSyncState: string | null;
  zoomMeetingId: string | null;
  zoomAccountId: string | null;
  zoomSyncState: string | null;
  /** updated_at as Postgres prints it — microseconds intact, which a JS Date would drop. */
  updatedAtText: string;
};

async function load(db: DbOrTx, id: string): Promise<Loaded | null> {
  const [r] = await db
    .select({
      id: appointment.id,
      agencyId: appointment.agencyId,
      contactName: contact.name,
      title: appointment.title,
      type: appointment.type,
      status: appointment.status,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      timezone: appointment.timezone,
      location: appointment.location,
      meetingUrl: appointment.meetingUrl,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
      assignedAgentId: appointment.assignedAgentId,
      agentRole: membership.role,
      externalCalendarId: appointment.externalCalendarId,
      externalCalendarAccountId: appointment.externalCalendarAccountId,
      calendarSyncState: appointment.calendarSyncState,
      zoomMeetingId: appointment.zoomMeetingId,
      zoomAccountId: appointment.zoomAccountId,
      zoomSyncState: appointment.zoomSyncState,
      updatedAtText: sql<string>`${appointment.updatedAt}::text`,
    })
    .from(appointment)
    .innerJoin(contact, eq(contact.id, appointment.contactId))
    .leftJoin(property, eq(property.id, appointment.propertyId))
    // The agent's CURRENT membership: a member who left has no connection to act through.
    .leftJoin(
      membership,
      and(eq(membership.userId, appointment.assignedAgentId), eq(membership.agencyId, appointment.agencyId), eq(membership.status, 'active')),
    )
    .where(eq(appointment.id, id))
    .limit(1);
  if (!r) return null;
  return {
    ...r,
    type: r.type as AppointmentType,
    status: r.status as AppointmentStatus,
    startsAt: new Date(r.startsAt),
    endsAt: new Date(r.endsAt),
    agentRole: (r.agentRole as MembershipRole | null) ?? null,
    propertyAddress: r.suburb
      ? formatAddress({ unit: r.unit, streetNumber: r.streetNumber, street: r.street, suburb: r.suburb, state: r.state ?? '', postcode: r.postcode ?? '' })
      : null,
  };
}

/** The assigned agent as an actor — the only identity a sync ever uses. */
function agentActor(a: Loaded): Actor | null {
  if (!a.assignedAgentId || !a.agentRole) return null;
  return { userId: a.assignedAgentId, agencyId: a.agencyId, membershipRole: a.agentRole };
}

const active = (a: Loaded) => (ACTIVE_STATUSES as readonly string[]).includes(a.status);

export function calendarDescription(a: Pick<Loaded, 'contactName' | 'type' | 'propertyAddress' | 'meetingUrl'>): string {
  return [
    `With: ${a.contactName}`,
    `Type: ${APPOINTMENT_TYPE_LABELS[a.type]}`,
    ...(a.propertyAddress ? [`Property: ${a.propertyAddress}`] : []),
    ...(a.meetingUrl ? [`Join: ${a.meetingUrl}`] : []),
    '',
    'Booked in the agency console, which stays the record: change it there. A change made here in Google is flagged in the console, not copied.',
  ].join('\n');
}

function eventInput(a: Loaded): CalendarEventInput {
  return {
    title: a.title,
    description: calendarDescription(a),
    location: a.location ?? a.propertyAddress,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    timezone: a.timezone,
    appointmentId: a.id,
  };
}

function meetingInput(a: Loaded): ZoomMeetingInput {
  return { title: a.title, startsAt: a.startsAt, endsAt: a.endsAt, timezone: a.timezone };
}

/** Take the row for one run. Null when another run holds it. */
async function claim(db: DbOrTx, id: string, now: Date): Promise<boolean> {
  const stale = new Date(now.getTime() - CLAIM_STALE_MS);
  const got = await db
    .update(appointment)
    .set({ syncClaimedAt: now })
    .where(and(eq(appointment.id, id), or(isNull(appointment.syncClaimedAt), lt(appointment.syncClaimedAt, stale))))
    .returning({ id: appointment.id });
  return got.length > 0;
}

/** Let go — unless the row changed under us, in which case keep it and go round again. */
async function release(db: DbOrTx, id: string, seen: string): Promise<'done' | 'changed'> {
  const released = await db
    .update(appointment)
    .set({ syncClaimedAt: null })
    .where(and(eq(appointment.id, id), sql`${appointment.updatedAt} = ${seen}::timestamptz`))
    .returning({ id: appointment.id });
  return released.length ? 'done' : 'changed';
}

async function syncZoom(db: DbOrTx, deps: SyncDeps, a: Loaded, agent: Actor | null): Promise<SyncState | null> {
  const ours = a.zoomMeetingId !== null;
  // A Zoom appointment with a link of their own (or any other type) is not ours to create.
  const wantCreate = a.type === 'zoom' && !ours && !a.meetingUrl && active(a);
  if (!ours && !wantCreate) {
    // Nothing of ours, and nothing to make (cancelled before it was created, or a link of their own):
    // a pending mark or an old "connect Zoom first" no longer applies.
    if (a.zoomSyncState !== null) await db.update(appointment).set({ zoomSyncState: null, zoomSyncError: null }).where(eq(appointment.id, a.id));
    return null;
  }
  if (ours && a.zoomSyncState === 'removed') return 'removed';

  const fail = async (err: unknown): Promise<SyncState> => {
    await db.update(appointment).set({ zoomSyncState: 'failed', zoomSyncError: syncErrorMessage('Zoom', err) }).where(eq(appointment.id, a.id));
    return 'failed';
  };
  if (!deps.keys) return fail(new IntegrationError('unavailable', 'integrations are not set up on this server'));
  if (!agent) return fail(new IntegrationError('not_found', 'no agent'));

  try {
    if (wantCreate) {
      const { accountId, requirement } = await resolveIntegration(db, agent, 'zoom');
      if (!accountId) {
        await db
          .update(appointment)
          .set({
            zoomSyncState: 'failed',
            zoomSyncError:
              requirement.state === 'expired'
                ? 'Zoom needs reconnecting — open Integrations, reconnect, then Retry.'
                : 'Connect Zoom first (the agent’s own, or the agency’s), then Retry.',
          })
          .where(eq(appointment.id, a.id));
        return 'failed';
      }
      const m = await withAccessToken(db, deps.keys, agent, accountId, deps, (t) => zoomApiFor(deps, t).create(t, meetingInput(a)));
      await db
        .update(appointment)
        .set({ zoomMeetingId: m.id, zoomAccountId: accountId, meetingUrl: m.joinUrl, zoomSyncState: 'synced', zoomSyncedAt: sql`now()`, zoomSyncError: null })
        .where(eq(appointment.id, a.id));
      a.meetingUrl = m.joinUrl;
      await markUsed(db, accountId);
      return 'synced';
    }
    // An existing meeting: the account that created it, or nothing.
    if (!a.zoomAccountId) throw new IntegrationError('not_found', 'The Zoom connection that created this meeting was disconnected');
    const accountId = a.zoomAccountId;
    if (active(a)) {
      await withAccessToken(db, deps.keys, agent, accountId, deps, (t) => zoomApiFor(deps, t).update(t, a.zoomMeetingId!, meetingInput(a)));
      await db.update(appointment).set({ zoomSyncState: 'synced', zoomSyncedAt: sql`now()`, zoomSyncError: null }).where(eq(appointment.id, a.id));
      await markUsed(db, accountId);
      return 'synced';
    }
    if (a.status === 'cancelled') {
      await withAccessToken(db, deps.keys, agent, accountId, deps, (t) => zoomApiFor(deps, t).remove(t, a.zoomMeetingId!));
      await db.update(appointment).set({ zoomSyncState: 'removed', zoomSyncedAt: sql`now()`, zoomSyncError: null }).where(eq(appointment.id, a.id));
      await markUsed(db, accountId);
      return 'removed';
    }
    // Completed: the meeting has happened; leave it be.
    return (a.zoomSyncState as SyncState | null) ?? 'synced';
  } catch (err) {
    return fail(err);
  }
}

async function syncCalendar(db: DbOrTx, deps: SyncDeps, a: Loaded, agent: Actor | null): Promise<SyncState | null> {
  const hasEvent = a.externalCalendarId !== null && a.calendarSyncState !== 'removed';
  const fail = async (err: unknown): Promise<SyncState> => {
    await db.update(appointment).set({ calendarSyncState: 'failed', calendarSyncError: syncErrorMessage('Google Calendar', err) }).where(eq(appointment.id, a.id));
    return 'failed';
  };
  // Nothing to remove and nothing to add.
  if (!hasEvent && !active(a)) {
    if (a.calendarSyncState === 'pending') await db.update(appointment).set({ calendarSyncState: null }).where(eq(appointment.id, a.id));
    return a.calendarSyncState === 'pending' ? null : ((a.calendarSyncState as SyncState | null) ?? null);
  }
  if (!agent) return hasEvent ? fail(new IntegrationError('not_found', 'no agent')) : null;

  // Which connection: the one that wrote the event; for a new event, the agent's own calendar.
  let accountId = hasEvent ? a.externalCalendarAccountId : null;
  if (!hasEvent) {
    const r = await resolveIntegration(db, agent, 'google_calendar');
    accountId = r.accountId;
    if (!accountId) {
      // Never connected: not mirrored, and nothing to warn about. Connected but unusable: say so.
      if (r.requirement.state === 'not_connected') {
        await db.update(appointment).set({ calendarSyncState: null, calendarSyncError: null }).where(eq(appointment.id, a.id));
        return null;
      }
      return fail(new IntegrationError(r.requirement.state === 'expired' ? 'expired' : 'unavailable', 'Google Calendar is not usable — open Integrations'));
    }
  }
  if (!accountId) return fail(new IntegrationError('not_found', 'The Google Calendar connection that holds this event was disconnected'));
  if (!deps.keys) return fail(new IntegrationError('unavailable', 'integrations are not set up on this server'));
  const keys = deps.keys;

  try {
    if (active(a)) {
      const ev = await withAccessToken(db, keys, agent, accountId, deps, (t) => calendarApiFor(deps, t).upsert(t, eventInput(a)));
      await db
        .update(appointment)
        .set({
          externalCalendarId: ev.id,
          externalCalendarProvider: 'google_calendar',
          externalCalendarAccountId: accountId,
          externalCalendarEtag: ev.etag,
          calendarSyncState: 'synced',
          calendarSyncedAt: sql`now()`,
          calendarSyncError: null,
          calendarConflict: null,
        })
        .where(eq(appointment.id, a.id));
      await markUsed(db, accountId);
      return 'synced';
    }
    if (a.status === 'cancelled') {
      await withAccessToken(db, keys, agent, accountId, deps, (t) => calendarApiFor(deps, t).remove(t, a.externalCalendarId!));
      await db
        .update(appointment)
        .set({ calendarSyncState: 'removed', calendarSyncedAt: sql`now()`, calendarSyncError: null, calendarConflict: null, externalCalendarEtag: null })
        .where(eq(appointment.id, a.id));
      await markUsed(db, accountId);
      return 'removed';
    }
    // Completed: keep the event as a record, marked done.
    const ev = await withAccessToken(db, keys, agent, accountId, deps, (t) => calendarApiFor(deps, t).setTitle(t, a.externalCalendarId!, `✓ ${a.title}`));
    await db
      .update(appointment)
      .set({ externalCalendarEtag: ev.etag, calendarSyncState: 'synced', calendarSyncedAt: sql`now()`, calendarSyncError: null, calendarConflict: null })
      .where(eq(appointment.id, a.id));
    await markUsed(db, accountId);
    return 'synced';
  } catch (err) {
    return fail(err);
  }
}

/**
 * Make Google Calendar and Zoom match this appointment. Safe to call twice
 * at once (the second finds it claimed and does nothing), and safe to call
 * again later (it converges). Never throws for a provider problem: the
 * outcome is written on the row for the screen to show, with Retry.
 */
export async function syncAppointment(db: DbOrTx, deps: SyncDeps, appointmentId: string): Promise<SyncOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  if (!(await claim(db, appointmentId, now))) return { ran: false, calendar: null, zoom: null };
  let outcome: SyncOutcome = { ran: true, calendar: null, zoom: null };
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const a = await load(db, appointmentId);
      if (!a) return outcome;
      const agent = agentActor(a);
      const zoom = await syncZoom(db, deps, a, agent);
      const calendar = await syncCalendar(db, deps, a, agent);
      outcome = { ran: true, calendar, zoom };
      if ((await release(db, appointmentId, a.updatedAtText)) === 'done') return outcome;
    }
    return outcome;
  } finally {
    // However it ended, never leave the row held (the release above is the normal path).
    await db.update(appointment).set({ syncClaimedAt: null }).where(eq(appointment.id, appointmentId)).catch(() => {});
  }
}

/** Mark what a change needs mirrored, in the change's own transaction — so a crash before the sync is picked up by the cron. */
export function pendingSyncFields(a: { type: string; meetingUrl: string | null; zoomMeeting: boolean }, status: AppointmentStatus) {
  const zoomRelevant = a.zoomMeeting || (a.type === 'zoom' && !a.meetingUrl && (ACTIVE_STATUSES as readonly string[]).includes(status));
  return {
    calendarSyncState: 'pending' as const,
    ...(zoomRelevant ? { zoomSyncState: 'pending' as const } : {}),
  };
}

/**
 * The cron's part (every 5 minutes, alongside the other ticks):
 *  1. re-run syncs left `pending` by a crash (unclaimed, or claimed long ago);
 *  2. read back events we created for upcoming appointments, and FLAG a
 *     change made inside Google (moved, or deleted) as a conflict — never
 *     copy it over our record. One `events.get` per event, with its ETag.
 */
export async function runAppointmentSyncTick(
  db: DbOrTx,
  deps: SyncDeps,
  opts: { limit?: number; checkEveryMs?: number; horizonDays?: number } = {},
): Promise<{ resumed: number; checked: number; conflicts: number; failed: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const limit = opts.limit ?? 25;
  const stale = new Date(now.getTime() - CLAIM_STALE_MS);

  const stuck = await db
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        or(eq(appointment.calendarSyncState, 'pending'), eq(appointment.zoomSyncState, 'pending')),
        or(isNull(appointment.syncClaimedAt), lt(appointment.syncClaimedAt, stale)),
        lt(appointment.updatedAt, stale),
      ),
    )
    .orderBy(asc(appointment.updatedAt))
    .limit(limit);
  let resumed = 0;
  for (const s of stuck) if ((await syncAppointment(db, deps, s.id)).ran) resumed++;

  const report = { resumed, checked: 0, conflicts: 0, failed: 0 };
  if (!deps.keys) return report;
  const checkBefore = new Date(now.getTime() - (opts.checkEveryMs ?? 5 * 60 * 1000));
  const horizon = new Date(now.getTime() + (opts.horizonDays ?? 60) * 86_400_000);
  const due = await db
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        eq(appointment.calendarSyncState, 'synced'),
        inArray(appointment.status, [...ACTIVE_STATUSES]),
        isNotNull(appointment.externalCalendarId),
        isNotNull(appointment.externalCalendarAccountId),
        gt(appointment.endsAt, now),
        lt(appointment.startsAt, horizon),
        isNull(appointment.syncClaimedAt),
        or(isNull(appointment.calendarCheckedAt), lt(appointment.calendarCheckedAt, checkBefore)),
      ),
    )
    .orderBy(sql`${appointment.calendarCheckedAt} asc nulls first`)
    .limit(limit);

  for (const d of due) {
    const r = await checkCalendarEvent(db, deps, d.id, now);
    if (r === 'conflict') report.conflicts++;
    else if (r === 'failed') report.failed++;
    report.checked++;
  }
  return report;
}

/** One read-back. Returns what it concluded; writes only the check time, a new ETag, or the conflict. */
export async function checkCalendarEvent(
  db: DbOrTx,
  deps: SyncDeps,
  appointmentId: string,
  now = new Date(),
): Promise<'unchanged' | 'same_times' | 'conflict' | 'failed' | 'skipped'> {
  const a = await load(db, appointmentId);
  const agent = a ? agentActor(a) : null;
  if (!a || !agent || !a.externalCalendarId || !a.externalCalendarAccountId || !deps.keys) return 'skipped';
  const [row] = await db.select({ etag: appointment.externalCalendarEtag }).from(appointment).where(eq(appointment.id, a.id)).limit(1);
  const accountId = a.externalCalendarAccountId;
  const eventId = a.externalCalendarId;
  try {
    const seen = await withAccessToken(db, deps.keys, agent, accountId, deps, (t) => calendarApiFor(deps, t).get(t, eventId, row?.etag ?? null));
    if (seen.kind === 'unchanged') {
      await db.update(appointment).set({ calendarCheckedAt: now }).where(eq(appointment.id, a.id));
      return 'unchanged';
    }
    const moved =
      seen.kind === 'changed' &&
      !seen.cancelled &&
      (seen.startsAt?.getTime() !== a.startsAt.getTime() || seen.endsAt?.getTime() !== a.endsAt.getTime());
    const deleted = seen.kind === 'gone' || (seen.kind === 'changed' && seen.cancelled);
    if (!moved && !deleted) {
      // Edited in Google without touching the time (a note, a colour): remember the new ETag, nothing to flag.
      await db
        .update(appointment)
        .set({ calendarCheckedAt: now, externalCalendarEtag: seen.kind === 'changed' ? seen.etag : null })
        .where(eq(appointment.id, a.id));
      return 'same_times';
    }
    const conflict: CalendarConflict = {
      startsAt: seen.kind === 'changed' && !deleted ? (seen.startsAt?.toISOString() ?? null) : null,
      endsAt: seen.kind === 'changed' && !deleted ? (seen.endsAt?.toISOString() ?? null) : null,
      deleted,
      seenAt: now.toISOString(),
    };
    // Guarded on 'synced': a sync that started meanwhile wins, and is not overwritten by a stale read.
    await db
      .update(appointment)
      .set({
        calendarSyncState: 'conflict',
        calendarConflict: conflict,
        calendarCheckedAt: now,
        externalCalendarEtag: seen.kind === 'changed' ? seen.etag : null,
      })
      .where(and(eq(appointment.id, a.id), eq(appointment.calendarSyncState, 'synced'), isNull(appointment.syncClaimedAt)));
    return 'conflict';
  } catch {
    // An expired connection shows on its card; the appointment keeps its last good state.
    await db.update(appointment).set({ calendarCheckedAt: now }).where(eq(appointment.id, a.id));
    return 'failed';
  }
}
