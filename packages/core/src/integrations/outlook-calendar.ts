import { randomBytes } from 'node:crypto';
import { call, ProviderError, str, type Fetch } from './provider-http';
import type { CalendarApi, CalendarEventInput, CalendarEventRef, CalendarEventSeen } from './google-calendar';

/**
 * The Outlook Calendar calls an appointment needs (ADR 0076; Microsoft Graph v1.0, checked 2026-10-31), on the
 * person's default calendar, all within `Calendars.ReadWrite`:
 *  - Outlook chooses event ids, so a create carries `transactionId` = our appointment id (a retried create does
 *    not make a second event), and an update needs the id we stored (`existingId`). An update of an event
 *    deleted in Outlook (404) creates it again.
 *  - No attendees, ever: Outlook never invites the contact. Our own invitation (with approval) is how they hear.
 *  - Times are sent and read as UTC (`Prefer: outlook.timezone="UTC"`), so no time-zone name ever needs mapping.
 *  - Reading back is one GET per event we created; the change key (`@odata.etag`) we stored says "unchanged".
 */

export const OUTLOOK_EVENTS_URL = 'https://graph.microsoft.com/v1.0/me/events';
const UTC = { prefer: 'outlook.timezone="UTC"' };

/** Only an id in Outlook's own alphabet ever reaches a URL path. */
function safeId(eventId: string): string {
  if (!/^[A-Za-z0-9+/=_-]{8,1024}$/.test(eventId)) throw new ProviderError('failed', 'That Outlook Calendar event id is not valid');
  return encodeURIComponent(eventId);
}

const utc = (d: Date) => ({ dateTime: d.toISOString().replace(/Z$/, ''), timeZone: 'UTC' });

function body(e: CalendarEventInput) {
  return {
    subject: e.title,
    body: { contentType: 'text', content: e.description },
    ...(e.location ? { location: { displayName: e.location } } : {}),
    start: utc(e.startsAt),
    end: utc(e.endsAt),
    // Restores an event cancelled in Outlook when Retry re-sends it.
    isCancelled: false,
  };
}

function ref(json: Record<string, unknown> | null, fallbackId: string | null): CalendarEventRef {
  const id = str(json?.id) ?? fallbackId;
  if (!id) throw new ProviderError('failed', 'Outlook Calendar sent back something unexpected');
  return { id, etag: str(json?.['@odata.etag']) ?? str(json?.changeKey) };
}

/** Graph's UTC dateTime ("2026-11-03T23:00:00.0000000") as a Date. */
function when(v: unknown): Date | null {
  const dt = v && typeof v === 'object' ? str((v as { dateTime?: unknown }).dateTime) : null;
  if (!dt) return null;
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(dt) ? dt : `${dt.replace(/(\.\d{3})\d+$/, '$1')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function outlookCalendarApi(fetchImpl: Fetch = fetch): CalendarApi {
  const auth = (token: string) => ({ authorization: `Bearer ${token}`, ...UTC });
  const json = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });
  const what = 'Outlook Calendar';

  async function create(token: string, e: CalendarEventInput): Promise<CalendarEventRef> {
    const r = await call(fetchImpl, what, OUTLOOK_EVENTS_URL, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ ...body(e), transactionId: e.appointmentId }),
    });
    return ref(r.json, null);
  }

  async function patch(token: string, eventId: string, fields: Record<string, unknown>): Promise<CalendarEventRef> {
    const r = await call(fetchImpl, what, `${OUTLOOK_EVENTS_URL}/${safeId(eventId)}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify(fields),
    });
    return ref(r.json, eventId);
  }

  return {
    async upsert(token, e, existingId) {
      if (!existingId) return create(token, e);
      try {
        return await patch(token, existingId, body(e));
      } catch (err) {
        // Deleted in Outlook meanwhile: put it back.
        if (err instanceof ProviderError && err.kind === 'not_found') return create(token, e);
        throw err;
      }
    },
    setTitle(token, eventId, title) {
      return patch(token, eventId, { subject: title });
    },
    async remove(token, eventId) {
      try {
        await call(fetchImpl, what, `${OUTLOOK_EVENTS_URL}/${safeId(eventId)}`, { method: 'DELETE', headers: auth(token) });
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'not_found') return; // already gone — what we wanted
        throw err;
      }
    },
    async get(token, eventId, etag): Promise<CalendarEventSeen> {
      try {
        const r = await call(fetchImpl, what, `${OUTLOOK_EVENTS_URL}/${safeId(eventId)}?$select=start,end,isCancelled`, { headers: auth(token) });
        const now = str(r.json?.['@odata.etag']) ?? str(r.json?.changeKey);
        if (etag && now && now === etag) return { kind: 'unchanged' };
        return { kind: 'changed', etag: now, startsAt: when(r.json?.start), endsAt: when(r.json?.end), cancelled: r.json?.isCancelled === true };
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'not_found') return { kind: 'gone' };
        throw err;
      }
    },
  };
}

/** The dev stub's Outlook Calendar: answers like Graph, remembers nothing, never leaves the machine. */
export function stubOutlookCalendarApi(): CalendarApi {
  const tag = () => `W/"stub-${randomBytes(6).toString('hex')}"`;
  return {
    async upsert(_token, _e, existingId) {
      return { id: existingId ?? `stubOutlook${randomBytes(12).toString('hex')}`, etag: tag() };
    },
    async setTitle(_token, eventId) {
      return { id: eventId, etag: tag() };
    },
    async remove() {},
    async get() {
      return { kind: 'unchanged' };
    },
  };
}
