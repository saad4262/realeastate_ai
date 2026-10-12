import { describe, expect, it } from 'vitest';
import { buildMeetingIcs, escapeIcsText, foldIcsLine, icsSequence } from './ics';

const base = {
  appointmentId: '11111111-2222-4333-8444-555555555555',
  sequence: 7,
  status: 'CONFIRMED' as const,
  title: 'Weekly sync; listings, offers',
  description: 'Agenda:\nOne\\two',
  location: null,
  url: 'https://zoom.us/j/123?pwd=abc',
  startsAt: new Date('2026-10-13T04:00:00Z'),
  endsAt: new Date('2026-10-13T04:30:00Z'),
  now: new Date('2026-10-12T10:00:00Z'),
};

describe('meeting .ics', () => {
  it('is a PUBLISH calendar with one event in UTC, CRLF line ends, no RSVP parties', () => {
    const ics = buildMeetingIcs(base);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.split('\r\n').filter((l) => l && !l.startsWith(' ')).every((l) => /^[A-Z-]+[:;]/.test(l))).toBe(true);
    expect(ics).toContain('METHOD:PUBLISH');
    expect(ics).toContain('UID:appointment-11111111-2222-4333-8444-555555555555@property-platform');
    expect(ics).toContain('SEQUENCE:7');
    expect(ics).toContain('DTSTART:20261013T040000Z');
    expect(ics).toContain('DTEND:20261013T043000Z');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).not.toMatch(/ORGANIZER|ATTENDEE/);
  });

  it('escapes text so a title cannot break the file', () => {
    expect(escapeIcsText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
    const ics = buildMeetingIcs({ ...base, title: 'x\r\nEND:VEVENT' });
    expect(ics.split('\r\n').filter((l) => l === 'END:VEVENT')).toHaveLength(1);
    expect(ics).toContain('SUMMARY:x\\nEND:VEVENT');
  });

  it('folds long lines at 75 octets without splitting a character', () => {
    const long = `DESCRIPTION:${'é'.repeat(80)}`;
    const folded = foldIcsLine(long);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(long);
  });

  it('a cancellation keeps the UID and says CANCELLED; the sequence only rises', () => {
    const cancelled = buildMeetingIcs({ ...base, status: 'CANCELLED', sequence: 8 });
    expect(cancelled).toContain('STATUS:CANCELLED');
    expect(cancelled).toContain('UID:appointment-11111111-2222-4333-8444-555555555555@property-platform');
    expect(icsSequence(new Date('2026-10-12T10:00:01Z'))).toBeGreaterThan(icsSequence(new Date('2026-10-12T10:00:00Z')));
    expect(icsSequence(new Date('2025-01-01T00:00:00Z'))).toBe(0);
  });
});
