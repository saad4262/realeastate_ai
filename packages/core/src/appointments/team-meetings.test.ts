import { describe, expect, it } from 'vitest';
import { appointmentKindEnum } from '@repo/db';
import { can, type Actor } from '../permissions';
import { buildTeamMeetingEmail, type TeamMeetingEmailInput } from '../email/team-notices';
import { APPOINTMENT_KINDS, MAX_TEAM_PARTICIPANTS, scheduleTeamMeetingSchema } from './appointment-schema';
import { appointmentResource } from './appointments';

const AGENCY = '00000000-0000-4000-8000-0000000000aa';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const member = (n: number, role: Actor['membershipRole'] = 'agent'): Actor => ({ userId: id(n), agencyId: AGENCY, membershipRole: role });

const meeting = appointmentResource({ id: id(900), agencyId: AGENCY, assignedAgentId: id(1), createdBy: id(1), participantIds: [id(2), id(3)] });

describe('team meetings — who may see and answer one (ADR 0038 §3)', () => {
  it('the host, the colleagues on it and an admin read it; another agent does not', () => {
    expect(can(member(1), 'appointment:read', meeting)).toBe(true);
    expect(can(member(2), 'appointment:read', meeting)).toBe(true);
    expect(can(member(3, 'read_only'), 'appointment:read', meeting)).toBe(true);
    expect(can(member(4), 'appointment:read', meeting)).toBe(false);
    expect(can(member(5, 'admin'), 'appointment:read', meeting)).toBe(true);
    expect(can({ ...member(2), agencyId: id(999) }, 'appointment:read', meeting)).toBe(false);
  });

  it('only a colleague on it may decline; the host and admins change it instead', () => {
    expect(can(member(2), 'appointment:respond', meeting)).toBe(true);
    expect(can(member(3, 'read_only'), 'appointment:respond', meeting)).toBe(true);
    expect(can(member(1), 'appointment:respond', meeting)).toBe(false);
    expect(can(member(5, 'admin'), 'appointment:respond', meeting)).toBe(false);
    expect(can(member(4), 'appointment:respond', meeting)).toBe(false);
  });

  it('a colleague on it may not move or cancel it; the host and an admin may', () => {
    expect(can(member(2), 'appointment:update', meeting)).toBe(false);
    expect(can(member(1), 'appointment:update', meeting)).toBe(true);
    expect(can(member(5, 'admin'), 'appointment:update', meeting)).toBe(true);
  });
});

describe('team meeting contract', () => {
  const base = {
    title: 'Weekly sync',
    type: 'zoom' as const,
    startsAt: '2026-10-13T04:00:00Z',
    endsAt: '2026-10-13T04:30:00Z',
    timezone: 'Australia/Sydney',
    participantIds: [id(2)],
  };

  it('the kinds match the database enum', () => expect([...APPOINTMENT_KINDS]).toEqual([...appointmentKindEnum.enumValues]));

  it('needs 1–10 distinct colleagues, an end after the start, and a type a meeting can have', () => {
    expect(scheduleTeamMeetingSchema.safeParse(base).success).toBe(true);
    expect(scheduleTeamMeetingSchema.safeParse({ ...base, participantIds: [] }).success).toBe(false);
    expect(scheduleTeamMeetingSchema.safeParse({ ...base, participantIds: [id(2), id(2)] }).success).toBe(false);
    expect(scheduleTeamMeetingSchema.safeParse({ ...base, participantIds: Array.from({ length: MAX_TEAM_PARTICIPANTS + 1 }, (_, i) => id(i + 10)) }).success).toBe(false);
    expect(scheduleTeamMeetingSchema.safeParse({ ...base, endsAt: base.startsAt }).success).toBe(false);
    expect(scheduleTeamMeetingSchema.safeParse({ ...base, type: 'appraisal' }).success).toBe(false);
    expect(scheduleTeamMeetingSchema.safeParse({ ...base, meetingUrl: 'javascript:alert(1)' }).success).toBe(false);
  });
});

describe('team meeting email (ADR 0038 §5)', () => {
  const input: TeamMeetingEmailInput = {
    to: { email: 'saad@example.com', name: 'Saad' },
    from: { email: 'noreply@example.com', name: 'Example' },
    postalAddress: '1 George St, Sydney NSW 2000',
    agencyName: 'Alpha',
    event: 'booked',
    title: 'Sync <b>',
    when: 'Tue 13 Oct 2026, 3:00 pm AEDT – 3:30 pm',
    was: null,
    by: 'Alpha Owner',
    host: 'Alpha Owner',
    people: ['Sara'],
    agenda: 'Offers <script>',
    location: null,
    joinUrl: 'https://zoom.us/j/123',
    calendarUrl: 'https://agents.example.com/my-calendar',
    ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
  };

  it('booked: the join link, the people, the agenda, escaped — and the .ics attached', () => {
    const m = buildTeamMeetingEmail(input);
    expect(m.kind).toBe('transactional');
    expect(m.subject).toBe('Alpha Owner invited you: Sync <b>');
    expect(m.html).toContain('href="https://zoom.us/j/123"');
    expect(m.html).not.toContain('<b>');
    expect(m.html).not.toContain('<script>');
    expect(m.text).toContain('Join: https://zoom.us/j/123');
    expect(m.text).toContain('With: Sara');
    expect(m.text).toContain('1 George St, Sydney NSW 2000');
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments![0]).toMatchObject({ filename: 'meeting.ics', contentType: expect.stringContaining('text/calendar') });
    expect(Buffer.from(m.attachments![0]!.contentBase64, 'base64').toString('utf8')).toBe(input.ics);
  });

  it('cancelled: no join link; declined: no attachment', () => {
    const c = buildTeamMeetingEmail({ ...input, event: 'cancelled' });
    expect(c.subject).toBe('Cancelled: Sync <b>');
    expect(c.text).not.toContain('Join:');
    expect(c.html).not.toContain('zoom.us/j/123');
    const d = buildTeamMeetingEmail({ ...input, event: 'declined', by: 'Saad' });
    expect(d.subject).toBe('Saad can’t make it: Sync <b>');
    expect(d.attachments).toBeUndefined();
  });

  it('moved says what it was', () => {
    const m = buildTeamMeetingEmail({ ...input, event: 'moved', was: 'Tue 13 Oct 2026, 2:00 pm AEDT – 2:30 pm' });
    expect(m.text).toContain('Was: Tue 13 Oct 2026, 2:00 pm AEDT – 2:30 pm');
  });

  it('refuses to build without the sender footer (Spam Act identification)', () => {
    expect(() => buildTeamMeetingEmail({ ...input, postalAddress: '' })).toThrow();
  });
});
