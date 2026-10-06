import { randomInt } from 'node:crypto';
import { call, ProviderError, str, type Fetch } from './provider-http';
import { ZOOM_API } from './zoom-oauth';

/**
 * The Zoom meeting calls an appointment needs (Meetings API v2, granular
 * user-level scopes meeting:write/update/delete:meeting).
 *
 * What we keep: the meeting id and the participants' join link — the link the
 * contact needs, shown only to who may read the appointment (its agent, who
 * booked it, the agency's admins) and sent only by our approved invitation.
 * What we NEVER keep: the host's `start_url` (it starts the meeting AS the
 * host) and the separate `password` fields. They are dropped here, before
 * anything is returned.
 */

export type ZoomMeetingInput = { title: string; startsAt: Date; endsAt: Date; timezone: string };
export type ZoomMeetingRef = { id: string; joinUrl: string };

export type ZoomApi = {
  create(token: string, m: ZoomMeetingInput): Promise<ZoomMeetingRef>;
  update(token: string, meetingId: string, m: ZoomMeetingInput): Promise<void>;
  remove(token: string, meetingId: string): Promise<void>;
};

function fields(m: ZoomMeetingInput) {
  return {
    topic: m.title.slice(0, 200),
    type: 2, // a scheduled meeting
    // UTC with a Z: Zoom reads it as an instant; `timezone` is how Zoom displays it.
    start_time: m.startsAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration: Math.max(1, Math.round((m.endsAt.getTime() - m.startsAt.getTime()) / 60_000)),
    timezone: m.timezone,
  };
}

/** Zoom meeting ids are numbers; only digits ever reach a URL path. */
function safeId(meetingId: string): string {
  if (!/^\d{5,20}$/.test(meetingId)) throw new ProviderError('failed', 'That Zoom meeting id is not valid');
  return meetingId;
}

export function zoomMeetingsApi(fetchImpl: Fetch = fetch): ZoomApi {
  const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  return {
    async create(token, m) {
      const r = await call(fetchImpl, 'Zoom', `${ZOOM_API}/users/me/meetings`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(fields(m)),
      });
      const id = r.json?.id;
      const joinUrl = str(r.json?.join_url);
      if ((typeof id !== 'number' && typeof id !== 'string') || !joinUrl || !/^https:\/\//.test(joinUrl)) {
        throw new ProviderError('failed', 'Zoom sent back a meeting without an id or a join link');
      }
      // start_url and password are deliberately not read.
      return { id: String(id), joinUrl };
    },
    async update(token, meetingId, m) {
      await call(fetchImpl, 'Zoom', `${ZOOM_API}/meetings/${safeId(meetingId)}`, {
        method: 'PATCH',
        headers: headers(token),
        body: JSON.stringify(fields(m)),
      });
    },
    async remove(token, meetingId) {
      try {
        await call(fetchImpl, 'Zoom', `${ZOOM_API}/meetings/${safeId(meetingId)}`, { method: 'DELETE', headers: headers(token) });
      } catch (err) {
        // Already deleted in Zoom — the outcome we wanted.
        if (err instanceof ProviderError && err.kind === 'not_found') return;
        throw err;
      }
    },
  };
}

/** The dev stub's Zoom: a made-up meeting on example.com — clearly not a real link. */
export function stubZoomApi(): ZoomApi {
  return {
    async create() {
      const id = String(randomInt(10_000_000_000, 99_999_999_999));
      return { id, joinUrl: `https://example.com/stub-zoom/${id}` };
    },
    async update() {},
    async remove() {},
  };
}
