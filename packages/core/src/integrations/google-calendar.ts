import { randomBytes } from 'node:crypto';
import { call, ProviderError, str, type Fetch } from './provider-http';

/**
 * The few Google Calendar calls an appointment needs (Calendar API v3,
 * checked 2026-10-06). All on the person's `primary` calendar, all allowed
 * by `calendar.events.owned`.
 *
 *  - The event id is OURS, derived from the appointment id (Google accepts
 *    client-chosen ids: base32hex, 5–1024 chars; a uuid's hex digits are in
 *    that alphabet). Inserting twice therefore cannot make two events: the
 *    second insert gets 409 and becomes an update.
 *  - `sendUpdates=none` on every write, and no attendees at all: Google never
 *    emails the contact. Our own invitation (with approval) is how they hear.
 *  - Reading back is one `events.get` per event we created, with the ETag
 *    from our last write: unchanged costs a 304, and nothing else in the
 *    person's calendar is ever read.
 */

export const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export type CalendarEventInput = {
  title: string;
  description: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  /** Our appointment id, kept on the event as a private property. */
  appointmentId: string;
};

export type CalendarEventRef = { id: string; etag: string | null };

export type CalendarEventSeen =
  | { kind: 'unchanged' }
  | { kind: 'changed'; etag: string | null; startsAt: Date | null; endsAt: Date | null; cancelled: boolean }
  | { kind: 'gone' };

export type CalendarApi = {
  upsert(token: string, event: CalendarEventInput): Promise<CalendarEventRef>;
  setTitle(token: string, eventId: string, title: string): Promise<CalendarEventRef>;
  remove(token: string, eventId: string): Promise<void>;
  get(token: string, eventId: string, etag: string | null): Promise<CalendarEventSeen>;
};

/** The event id for an appointment: its uuid's hex digits, which Google's base32hex alphabet allows. */
export function eventIdFor(appointmentId: string): string {
  return appointmentId.replace(/-/g, '').toLowerCase();
}

/** Only an id in Google's own alphabet ever reaches a URL path. */
function safeId(eventId: string): string {
  if (!/^[a-v0-9]{5,1024}$/.test(eventId)) throw new ProviderError('failed', 'That Google Calendar event id is not valid');
  return eventId;
}

function body(e: CalendarEventInput) {
  return {
    summary: e.title,
    description: e.description,
    ...(e.location ? { location: e.location } : {}),
    start: { dateTime: e.startsAt.toISOString(), timeZone: e.timezone },
    end: { dateTime: e.endsAt.toISOString(), timeZone: e.timezone },
    // Re-confirms an event that was cancelled in Google and is being restored by Retry.
    status: 'confirmed',
    extendedProperties: { private: { crmAppointmentId: e.appointmentId } },
  };
}

function ref(json: Record<string, unknown> | null, fallbackId: string, etag: string | null): CalendarEventRef {
  return { id: str(json?.id) ?? fallbackId, etag: str(json?.etag) ?? etag };
}

function when(v: unknown): Date | null {
  const dt = v && typeof v === 'object' ? str((v as { dateTime?: unknown }).dateTime) ?? str((v as { date?: unknown }).date) : null;
  const d = dt ? new Date(dt) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

export function googleCalendarApi(fetchImpl: Fetch = fetch): CalendarApi {
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const json = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });
  const what = 'Google Calendar';

  async function patch(token: string, eventId: string, fields: Record<string, unknown>): Promise<CalendarEventRef> {
    const r = await call(fetchImpl, what, `${CALENDAR_EVENTS_URL}/${safeId(eventId)}?sendUpdates=none`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify(fields),
    });
    return ref(r.json, eventId, r.etag);
  }

  return {
    async upsert(token, e) {
      const id = eventIdFor(e.appointmentId);
      try {
        const r = await call(fetchImpl, what, `${CALENDAR_EVENTS_URL}?sendUpdates=none`, {
          method: 'POST',
          headers: json(token),
          body: JSON.stringify({ id, ...body(e) }),
        });
        return ref(r.json, id, r.etag);
      } catch (err) {
        // Already there (a retry, a double submit, a reschedule): update it in place.
        if (err instanceof ProviderError && err.kind === 'conflict') return patch(token, id, body(e));
        throw err;
      }
    },
    setTitle(token, eventId, title) {
      return patch(token, eventId, { summary: title });
    },
    async remove(token, eventId) {
      try {
        await call(fetchImpl, what, `${CALENDAR_EVENTS_URL}/${safeId(eventId)}?sendUpdates=none`, { method: 'DELETE', headers: auth(token) });
      } catch (err) {
        // Already deleted in Google — the outcome we wanted.
        if (err instanceof ProviderError && err.kind === 'not_found') return;
        throw err;
      }
    },
    async get(token, eventId, etag) {
      try {
        const r = await call(fetchImpl, what, `${CALENDAR_EVENTS_URL}/${safeId(eventId)}`, {
          headers: { ...auth(token), ...(etag ? { 'if-none-match': etag } : {}) },
        });
        if (r.status === 304) return { kind: 'unchanged' };
        return {
          kind: 'changed',
          etag: str(r.json?.etag) ?? r.etag,
          startsAt: when(r.json?.start),
          endsAt: when(r.json?.end),
          cancelled: r.json?.status === 'cancelled',
        };
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'not_found') return { kind: 'gone' };
        throw err;
      }
    },
  };
}

/** The dev stub's calendar: answers like Google, remembers nothing, never leaves the machine. */
export function stubCalendarApi(): CalendarApi {
  const etag = () => `"stub-${randomBytes(6).toString('hex')}"`;
  return {
    async upsert(_token, e) {
      return { id: eventIdFor(e.appointmentId), etag: etag() };
    },
    async setTitle(_token, eventId) {
      return { id: eventId, etag: etag() };
    },
    async remove() {},
    async get() {
      return { kind: 'unchanged' };
    },
  };
}
