import { describe, expect, it } from 'vitest';
import { clashMessage, isOverlapViolation, OVERLAP_CONSTRAINT } from './clash';
import { buildContactReminder, NO_ZOOM_LINK, reminderRecipients, startsIn, zoomLinkMissing } from './reminders';
import { DEFAULT_REMINDER_MINUTES, scheduleAppointmentSchema } from './appointment-schema';
import { buildMeetingReminderEmail, buildZoomFailedEmail } from '../email/team-notices';
import { scheduleAppointmentInput } from '../assistant/schema';

/** ADR 0032: the pure parts of meetings end to end. The SQL halves are in `pnpm smoke`. */

describe('no double booking — the readable half', () => {
  it('recognises the constraint error however the driver wraps it', () => {
    expect(isOverlapViolation({ code: '23P01', constraint_name: OVERLAP_CONSTRAINT })).toBe(true);
    expect(isOverlapViolation({ message: 'wrapped', cause: { code: '23P01', constraint_name: OVERLAP_CONSTRAINT } })).toBe(true);
    expect(isOverlapViolation({ code: '23P01', constraint_name: 'some_other_exclusion' })).toBe(false);
    expect(isOverlapViolation({ code: '23505', constraint_name: OVERLAP_CONSTRAINT })).toBe(false);
    expect(isOverlapViolation(new Error('nope'))).toBe(false);
    expect(isOverlapViolation(null)).toBe(false);
  });

  it('names the meeting in the way, in its own zone, and who is busy', () => {
    const c = {
      id: 'a',
      title: 'Appraisal at 12 Smith St',
      startsAt: new Date('2026-10-10T09:00:00Z'),
      endsAt: new Date('2026-10-10T10:00:00Z'),
      timezone: 'Australia/Sydney',
    };
    const mine = clashMessage(c, true);
    expect(mine).toMatch(/^You already have “Appraisal at 12 Smith St”/);
    expect(mine).toContain('8:00');
    expect(mine).toContain('9:00');
    expect(clashMessage(c, false)).toMatch(/^That agent already has/);
  });
});

describe('reminders', () => {
  const now = new Date('2026-10-10T09:45:00Z');
  it('says when, from the tick’s clock', () => {
    expect(startsIn(new Date('2026-10-10T10:00:00Z'), now)).toBe('in 15 minutes');
    expect(startsIn(new Date('2026-10-10T09:46:00Z'), now)).toBe('in 1 minute');
    expect(startsIn(new Date('2026-10-10T10:45:00Z'), now)).toBe('in 1 hour');
    expect(startsIn(new Date('2026-10-11T09:45:00Z'), now)).toBe('tomorrow');
    expect(startsIn(new Date('2026-10-10T09:40:00Z'), now)).toBe('starting now');
  });

  it('a booking that does not say gets 15 minutes; "No reminder" stays null', () => {
    const base = {
      title: 'Zoom',
      type: 'zoom',
      startsAt: '2026-10-10T09:00:00Z',
      endsAt: '2026-10-10T10:00:00Z',
      timezone: 'Australia/Sydney',
    } as const;
    expect(DEFAULT_REMINDER_MINUTES).toBe(15);
    expect(scheduleAppointmentSchema.parse(base).reminderMinutes).toBe(15);
    expect(scheduleAppointmentSchema.parse({ ...base, reminderMinutes: null }).reminderMinutes).toBeNull();
    expect(scheduleAppointmentSchema.parse({ ...base, reminderMinutes: 60 }).reminderMinutes).toBe(60);
  });

  it("the contact's reminder is a template: the time in the booked zone, the join link, no internal notes", () => {
    const { subject, body } = buildContactReminder(
      {
        title: 'Chat about 12 Smith St',
        type: 'zoom',
        startsAt: new Date('2026-10-10T09:00:00Z'),
        endsAt: new Date('2026-10-10T10:00:00Z'),
        timezone: 'Australia/Sydney',
        location: null,
        meetingUrl: 'https://zoom.us/j/123?pwd=abc',
        contactName: 'Bea Buyer',
      },
      { agentName: 'Sam Agent', agencyName: 'Harbour Realty' },
      new Date('2026-10-10T08:45:00Z'),
    );
    expect(subject).toBe('Reminder: Chat about 12 Smith St — in 15 minutes');
    expect(body).toContain('Hi Bea,');
    expect(body).toContain('zoom with Sam Agent from Harbour Realty');
    expect(body).toContain('Join: https://zoom.us/j/123?pwd=abc');
    expect(body).toContain('8:00');
    expect(body).not.toContain('undefined');
  });

  it("the agent's reminder email has a Join button when there is a link, and the sender footer", () => {
    const from = { email: 'noreply@example.com', name: 'Example' };
    const msg = buildMeetingReminderEmail({
      to: { email: 'sam@example.com', name: 'Sam' },
      from,
      postalAddress: '1 George St, Sydney NSW 2000',
      title: 'Chat <b>',
      withWhom: 'Bea',
      when: 'Sat 10 Oct 2026, 8:00 pm AEDT – 9:00 pm',
      startsIn: 'in 15 minutes',
      location: null,
      joinUrl: 'https://zoom.us/j/123',
      calendarUrl: 'https://agents.example.com/my-calendar',
    });
    expect(msg.kind).toBe('transactional');
    expect(msg.subject).toBe('Chat <b> — in 15 minutes');
    expect(msg.html).toContain('Join the meeting');
    expect(msg.html).toContain('Chat &lt;b&gt;');
    expect(msg.text).toContain('Join: https://zoom.us/j/123');
    expect(msg.text).toContain('1 George St, Sydney NSW 2000');
    const noLink = buildMeetingReminderEmail({ ...{ to: { email: 's@e.com' }, from, postalAddress: 'x', title: 't', withWhom: 'c', when: 'w', startsIn: 'now', location: 'Office', joinUrl: null, calendarUrl: 'https://a/my-calendar' } });
    expect(noLink.html).toContain('Open your calendar');
  });
});

describe('a Zoom meeting whose link was never created', () => {
  const from = { email: 'noreply@example.com', name: 'Example' };
  const person = (userId: string) => ({ userId, email: `${userId}@example.com`, name: userId, role: 'agent' as const });

  it('is recognised only for a Zoom meeting with no link', () => {
    expect(zoomLinkMissing({ type: 'zoom', meetingUrl: null })).toBe(true);
    expect(zoomLinkMissing({ type: 'zoom', meetingUrl: 'https://zoom.us/j/1' })).toBe(false);
    expect(zoomLinkMissing({ type: 'in_person', meetingUrl: null })).toBe(false);
  });

  it('a team meeting nobody was told about reminds its host and booker, never its colleagues', () => {
    const base = { kind: 'team', assignee: person('host'), booker: person('admin') };
    const untold = reminderRecipients({ ...base, invitationSentAt: null }, [person('colleague'), person('host')]);
    expect(untold.map((p) => p.userId)).toEqual(['host', 'admin']);
    const told = reminderRecipients({ ...base, invitationSentAt: new Date() }, [person('colleague'), person('host')]);
    expect(told.map((p) => p.userId)).toEqual(['host', 'admin', 'colleague']);
    // A client appointment has no colleagues to hold back; the booker who is the host is reminded once.
    expect(reminderRecipients({ kind: 'client', invitationSentAt: null, assignee: person('host'), booker: person('host') }, []).map((p) => p.userId)).toEqual(['host']);
  });

  it('the reminder says there is no link and how to fix it', () => {
    const msg = buildMeetingReminderEmail({ to: { email: 's@e.com' }, from, postalAddress: 'x', title: 't', withWhom: 'c', when: 'w', startsIn: 'in 5 minutes', location: null, joinUrl: null, problem: NO_ZOOM_LINK, calendarUrl: 'https://a/my-calendar' });
    expect(msg.text).toContain('No Zoom link yet');
    expect(msg.html).toContain('press Retry');
    expect(msg.html).toContain('Open your calendar');
    expect(msg.html).not.toContain('Join the meeting');
  });

  it('the host and booker are told why, and what to do', () => {
    const msg = buildZoomFailedEmail({
      to: { email: 'sam@example.com', name: 'Sam' },
      from,
      postalAddress: '1 George St, Sydney NSW 2000',
      title: 'Chat <b>',
      withWhom: 'Bea',
      when: 'Sat 10 Oct 2026, 8:00 pm AEDT – 9:00 pm',
      reason: 'Zoom needs reconnecting — open Integrations, reconnect, then Retry.',
      calendarUrl: 'https://agents.example.com/my-calendar',
    });
    expect(msg.kind).toBe('transactional');
    expect(msg.subject).toBe('No Zoom link yet: Chat <b>');
    expect(msg.html).toContain('Chat &lt;b&gt;');
    expect(msg.text).toContain('Why: Zoom needs reconnecting');
    expect(msg.text).toContain('Settings → Integrations');
    expect(msg.text).toContain('https://agents.example.com/my-calendar');
    expect(msg.text).toContain('1 George St, Sydney NSW 2000');
  });
});

describe('the assistant booking card takes send_invitation', () => {
  it('accepts it as a boolean and nothing else', () => {
    const base = { contact: 'C1', type: 'zoom', title: 'Chat', date: '2026-10-10', time: '20:00' };
    expect(scheduleAppointmentInput.parse({ ...base, send_invitation: true }).send_invitation).toBe(true);
    expect(scheduleAppointmentInput.parse(base).send_invitation).toBeUndefined();
    expect(scheduleAppointmentInput.safeParse({ ...base, send_invitation: 'yes' }).success).toBe(false);
  });
});
