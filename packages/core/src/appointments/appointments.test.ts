import { describe, expect, it } from 'vitest';
import { appointmentStatusEnum, appointmentTypeEnum } from '@repo/db/schema';
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES, contactNoticeFor, scheduleAppointmentSchema } from './appointment-schema';
import { buildCancellationNotice, buildInvitation } from './invitation';

describe('the appointment vocabularies match the database enums', () => {
  it('types', () => expect([...APPOINTMENT_TYPES]).toEqual([...appointmentTypeEnum.enumValues]));
  it('statuses', () => expect([...APPOINTMENT_STATUSES]).toEqual([...appointmentStatusEnum.enumValues]));
});

describe('booking an appointment', () => {
  const base = {
    title: 'Appraisal',
    type: 'appraisal' as const,
    startsAt: '2026-10-13T22:00:00.000Z',
    endsAt: '2026-10-13T23:00:00.000Z',
    timezone: 'Australia/Melbourne',
  };

  it('takes instants and a real zone, never a bare wall-clock time', () => {
    expect(scheduleAppointmentSchema.safeParse(base).success).toBe(true);
    expect(scheduleAppointmentSchema.safeParse({ ...base, startsAt: '2026-10-14T09:00' }).success).toBe(false);
    expect(scheduleAppointmentSchema.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(false);
  });

  it('refuses an end before the start', () => {
    expect(scheduleAppointmentSchema.safeParse({ ...base, endsAt: base.startsAt }).success).toBe(false);
  });

  it('refuses a meeting link that is not a web address', () => {
    expect(scheduleAppointmentSchema.safeParse({ ...base, meetingUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(scheduleAppointmentSchema.safeParse({ ...base, meetingUrl: 'https://zoom.us/j/1' }).success).toBe(true);
  });
});

describe('the invitation email', () => {
  const appt = {
    title: 'Appraisal of 12 Henry St',
    type: 'appraisal' as const,
    startsAt: new Date('2026-10-13T22:00:00.000Z'),
    endsAt: new Date('2026-10-13T23:00:00.000Z'),
    timezone: 'Australia/Melbourne',
    location: '12 Henry St, Pakenham',
    meetingUrl: null,
    propertyAddress: null,
    contactName: 'Tom Smith',
  };

  it("prints the time in the zone it was booked in, named — whatever the server's clock", () => {
    const { body } = buildInvitation(appt, { agentName: 'Sarah', agencyName: 'Alpha' });
    expect(body).toMatch(/14 Oct 2026/);
    expect(body).toMatch(/9:00/);
    expect(body).toMatch(/AEDT|GMT\+11/);
    expect(body).toMatch(/^Hi Tom,/);
  });

  it('carries no internal notes — the builder is never handed them', () => {
    // The type has no `notes`: an invitation cannot leak what the agent wrote for themselves.
    const { body } = buildInvitation({ ...appt, notes: 'Vendor is in debt' } as typeof appt, { agentName: 'S', agencyName: 'A' });
    expect(body).not.toMatch(/debt/);
  });

  it('a moved appointment’s email says it replaces the earlier one, with the new time and the same link', () => {
    const zoom = { ...appt, type: 'zoom' as const, meetingUrl: 'https://zoom.us/j/123' };
    const { subject, body } = buildInvitation(zoom, { agentName: 'Sarah', agencyName: 'Alpha' }, 'update');
    expect(subject).toMatch(/^Updated: Appraisal of 12 Henry St — /);
    expect(body).toContain('has changed');
    expect(body).toContain('instead of the earlier email');
    expect(body).toContain('Join: https://zoom.us/j/123');
    expect(body).toMatch(/9:00/);
  });

  it('a cancellation names the time it was, never a link, and never the reason', () => {
    // `outcome` (the reason) is handed in on purpose: the builder must not print it.
    const zoom = { ...appt, type: 'zoom' as const, meetingUrl: 'https://zoom.us/j/123', outcome: 'Vendor pulled out' } as Parameters<typeof buildCancellationNotice>[0];
    const { subject, body } = buildCancellationNotice(zoom, { agentName: 'Sarah', agencyName: 'Alpha' });
    expect(subject).toMatch(/^Cancelled: Appraisal of 12 Henry St — /);
    expect(body).toContain('has been cancelled');
    expect(body).toMatch(/^Was: .*9:00/m);
    expect(body).toContain('no longer works');
    expect(body).not.toContain('https://zoom.us/j/123');
    expect(body).not.toMatch(/pulled out/);
  });
});

describe('which email the contact needs (contactNoticeFor)', () => {
  const base = { kind: 'client' as const, status: 'scheduled' as const, invitationSentAt: null, contactInvitedBefore: false, cancellationSent: false };

  it('never emailed: the invitation; emailed for this time: nothing', () => {
    expect(contactNoticeFor(base)).toBe('invitation');
    expect(contactNoticeFor({ ...base, invitationSentAt: new Date(), contactInvitedBefore: true })).toBeNull();
  });

  it('emailed, then moved (which clears invitation_sent_at): the new details', () => {
    expect(contactNoticeFor({ ...base, status: 'rescheduled', contactInvitedBefore: true })).toBe('update');
  });

  it('emailed, then cancelled: the cancellation, once; never emailed: nothing to cancel', () => {
    const cancelled = { ...base, status: 'cancelled' as const };
    expect(contactNoticeFor({ ...cancelled, contactInvitedBefore: true })).toBe('cancellation');
    expect(contactNoticeFor({ ...cancelled, contactInvitedBefore: true, cancellationSent: true })).toBeNull();
    expect(contactNoticeFor(cancelled)).toBeNull();
  });

  it('a completed appointment and a team meeting need nothing from this', () => {
    expect(contactNoticeFor({ ...base, status: 'completed', contactInvitedBefore: true })).toBeNull();
    expect(contactNoticeFor({ ...base, kind: 'team' })).toBeNull();
    expect(contactNoticeFor({ ...base, kind: 'team', status: 'cancelled', contactInvitedBefore: true })).toBeNull();
  });
});
