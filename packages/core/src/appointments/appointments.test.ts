import { describe, expect, it } from 'vitest';
import { appointmentStatusEnum, appointmentTypeEnum } from '@repo/db/schema';
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES, scheduleAppointmentSchema } from './appointment-schema';
import { buildInvitation } from './invitation';

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
});
