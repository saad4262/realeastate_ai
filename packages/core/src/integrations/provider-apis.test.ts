import { describe, expect, it } from 'vitest';
import { syncErrorMessage } from '../appointments/sync';
import { IntegrationError } from './accounts';
import { fakeFetch } from './fake-fetch';
import { CALENDAR_EVENTS_URL, eventIdFor, googleCalendarApi, type CalendarEventInput } from './google-calendar';
import { ProviderError } from './provider-http';
import { zoomMeetingsApi } from './zoom-meetings';

const APPT = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const event: CalendarEventInput = {
  title: 'Appraisal',
  description: 'With: Tom',
  location: '12 Henry St',
  startsAt: new Date('2026-10-10T00:00:00Z'),
  endsAt: new Date('2026-10-10T01:00:00Z'),
  timezone: 'Australia/Melbourne',
  appointmentId: APPT,
};

describe('Google Calendar client', () => {
  it('our own event id, no attendees, and Google never emails anyone', async () => {
    const f = fakeFetch([{ status: 200, body: { id: eventIdFor(APPT), etag: '"e1"' } }]);
    const r = await googleCalendarApi(f.impl).upsert('tok', event);
    expect(eventIdFor(APPT)).toBe('0b1c2d3e4f5046178293a4b5c6d7e8f9');
    expect(r).toEqual({ id: eventIdFor(APPT), etag: '"e1"' });
    expect(eventIdFor(APPT)).toMatch(/^[0-9a-v]{5,1024}$/);
    const c = f.calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${CALENDAR_EVENTS_URL}?sendUpdates=none`);
    const sent = JSON.parse(c.body);
    expect(sent.id).toBe(eventIdFor(APPT));
    expect(sent.attendees).toBeUndefined();
    expect(sent.start).toEqual({ dateTime: '2026-10-10T00:00:00.000Z', timeZone: 'Australia/Melbourne' });
    expect(sent.extendedProperties.private.crmAppointmentId).toBe(APPT);
    expect(c.headers.authorization).toBe('Bearer tok');
  });

  it('a second insert of the same appointment (double submit, retry) updates instead of duplicating', async () => {
    const f = fakeFetch([
      { status: 409, body: { error: { code: 409, status: 'ALREADY_EXISTS', message: 'The requested identifier already exists.' } } },
      { status: 200, body: { id: eventIdFor(APPT), etag: '"e2"' } },
    ]);
    const r = await googleCalendarApi(f.impl).upsert('tok', event);
    expect(r.etag).toBe('"e2"');
    expect(f.calls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(f.calls[1]!.url).toBe(`${CALENDAR_EVENTS_URL}/${eventIdFor(APPT)}?sendUpdates=none`);
  });

  it('deleting an event that is already gone is fine', async () => {
    for (const status of [404, 410]) {
      const f = fakeFetch([{ status }]);
      await expect(googleCalendarApi(f.impl).remove('tok', 'abc12')).resolves.toBeUndefined();
      expect(f.calls[0]!.method).toBe('DELETE');
      expect(f.calls[0]!.url).toContain('sendUpdates=none');
    }
  });

  it('read-back: 304 is unchanged, a move is reported, a deletion is gone', async () => {
    const f = fakeFetch([
      { status: 304 },
      { status: 200, body: { etag: '"e3"', status: 'confirmed', start: { dateTime: '2026-10-10T03:00:00Z' }, end: { dateTime: '2026-10-10T04:00:00Z' } } },
      { status: 404 },
    ]);
    const api = googleCalendarApi(f.impl);
    expect(await api.get('tok', 'abc12', '"e1"')).toEqual({ kind: 'unchanged' });
    expect(f.calls[0]!.headers['if-none-match']).toBe('"e1"');
    const moved = await api.get('tok', 'abc12', '"e1"');
    expect(moved).toMatchObject({ kind: 'changed', etag: '"e3"', cancelled: false });
    expect(moved.kind === 'changed' && moved.startsAt?.toISOString()).toBe('2026-10-10T03:00:00.000Z');
    expect(await api.get('tok', 'abc12', '"e3"')).toEqual({ kind: 'gone' });
  });

  it('a refused token is "unauthorized" (so it is renewed once), a 500 is "failed"', async () => {
    const f = fakeFetch([{ status: 401 }, { status: 500 }]);
    const api = googleCalendarApi(f.impl);
    expect(((await api.upsert('tok', event).catch((e: unknown) => e)) as ProviderError).kind).toBe('unauthorized');
    expect(((await api.upsert('tok', event).catch((e: unknown) => e)) as ProviderError).kind).toBe('failed');
  });
});

describe('Zoom meetings client', () => {
  it('creates a scheduled meeting and keeps ONLY the id and the join link — never start_url or a password', async () => {
    const f = fakeFetch([
      {
        status: 201,
        body: {
          id: 85746065432,
          join_url: 'https://us05web.zoom.us/j/85746065432?pwd=abc',
          start_url: 'https://us05web.zoom.us/s/85746065432?zak=SECRET-HOST-KEY',
          password: 'p4ss',
          h323_password: '123',
          encrypted_password: 'enc',
        },
      },
    ]);
    const m = await zoomMeetingsApi(f.impl).create('tok', { title: 'Call', startsAt: event.startsAt, endsAt: new Date('2026-10-10T00:45:00Z'), timezone: 'Australia/Melbourne' });
    expect(m).toEqual({ id: '85746065432', joinUrl: 'https://us05web.zoom.us/j/85746065432?pwd=abc' });
    expect(JSON.stringify(m)).not.toMatch(/zak|SECRET|p4ss|enc/);
    const sent = JSON.parse(f.calls[0]!.body);
    expect(f.calls[0]!.url).toBe('https://api.zoom.us/v2/users/me/meetings');
    expect(sent).toEqual({ topic: 'Call', type: 2, start_time: '2026-10-10T00:00:00Z', duration: 45, timezone: 'Australia/Melbourne' });
  });

  it('moves and deletes by id; a meeting already deleted is fine; a non-numeric id never reaches the URL', async () => {
    const f = fakeFetch([{ status: 204 }, { status: 404, body: { code: 3001, message: 'Meeting does not exist' } }]);
    const api = zoomMeetingsApi(f.impl);
    await api.update('tok', '85746065432', { title: 'Call', startsAt: event.startsAt, endsAt: event.endsAt, timezone: 'UTC' });
    await expect(api.remove('tok', '85746065432')).resolves.toBeUndefined();
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'PATCH https://api.zoom.us/v2/meetings/85746065432',
      'DELETE https://api.zoom.us/v2/meetings/85746065432',
    ]);
    await expect(api.remove('tok', '../users/me')).rejects.toBeInstanceOf(ProviderError);
    expect(f.calls).toHaveLength(2);
  });
});

describe('what the agent is told when a sync fails', () => {
  it('names the fix, never a token', () => {
    expect(syncErrorMessage('Google Calendar', new IntegrationError('expired', 'x'))).toMatch(/reconnect/);
    expect(syncErrorMessage('Zoom', new ProviderError('rate_limited', 'Zoom answered 429', 429))).toMatch(/busy/);
    expect(syncErrorMessage('Zoom', new Error('Bearer ya29.secret'))).not.toContain('ya29');
  });
});
