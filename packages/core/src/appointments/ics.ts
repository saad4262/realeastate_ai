/**
 * A meeting as an iCalendar file (RFC 5545), attached to the team meeting
 * emails (ADR 0038 §5) so it can be added to any calendar in one click.
 *
 * - `METHOD:PUBLISH`, no ORGANIZER/ATTENDEE: a calendar adds it; nobody is
 *   offered RSVP buttons that would answer our no-reply sender. Declining is
 *   done in the console.
 * - The same UID for every email about one meeting and a SEQUENCE that only
 *   rises, so a calendar updates the one event when it moves or is cancelled
 *   (STATUS:CANCELLED). How a calendar treats a cancelled PUBLISH varies.
 * - Times in UTC (`…Z`), so no VTIMEZONE block is needed; the calendar shows
 *   them in the reader's own zone.
 */

export type MeetingIcsInput = {
  appointmentId: string;
  /** Rises with every change — see `icsSequence`. */
  sequence: number;
  status: 'CONFIRMED' | 'CANCELLED';
  title: string;
  description: string;
  location: string | null;
  url: string | null;
  startsAt: Date;
  endsAt: Date;
  /** DTSTAMP: when this file was made. */
  now: Date;
};

/** 20261012T030000Z */
function utc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** RFC 5545 §3.3.11: backslash, semicolon and comma escaped; a line break becomes \n. */
export function escapeIcsText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** RFC 5545 §3.1: lines longer than 75 octets continue on the next line after CRLF + one space, never inside a UTF-8 character. */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    // The first line holds 75 octets; each continuation 74 after its leading space.
    if (octets + size > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      octets = 0;
    }
    cur += ch;
    octets += size;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * A number that rises with every change to the meeting: seconds since
 * 2026-01-01 at its last update. Monotonic without storing a counter.
 */
export function icsSequence(updatedAt: Date): number {
  return Math.max(0, Math.floor((updatedAt.getTime() - Date.UTC(2026, 0, 1)) / 1000));
}

export function buildMeetingIcs(m: MeetingIcsInput): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Property Platform//Team meetings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:appointment-${m.appointmentId}@property-platform`,
    `SEQUENCE:${m.sequence}`,
    `DTSTAMP:${utc(m.now)}`,
    `DTSTART:${utc(m.startsAt)}`,
    `DTEND:${utc(m.endsAt)}`,
    `SUMMARY:${escapeIcsText(m.title)}`,
    `DESCRIPTION:${escapeIcsText(m.description)}`,
    ...(m.location ? [`LOCATION:${escapeIcsText(m.location)}`] : m.url ? [`LOCATION:${escapeIcsText(m.url)}`] : []),
    ...(m.url ? [`URL:${m.url}`] : []),
    `STATUS:${m.status}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}
