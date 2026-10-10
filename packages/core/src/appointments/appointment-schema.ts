import { z } from 'zod';
import { isValidTimeZone } from '../time/local-input';

/**
 * The contracts for appointments (docs/adr/0019). zod only — the console's
 * Schedule panel imports these to refuse a bad field before a round trip.
 * The vocabularies are copies of the database enums; the test fails if they
 * drift.
 */

export const APPOINTMENT_TYPES = ['appraisal', 'phone_call', 'zoom', 'inspection', 'meeting'] as const;
export type AppointmentType = (typeof APPOINTMENT_TYPES)[number];

export const APPOINTMENT_STATUSES = ['scheduled', 'completed', 'cancelled', 'rescheduled'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Still to happen. */
export const ACTIVE_STATUSES: readonly AppointmentStatus[] = ['scheduled', 'rescheduled'];

export const APPOINTMENT_TYPE_LABELS: Record<AppointmentType, string> = {
  appraisal: 'Appraisal',
  phone_call: 'Phone call',
  zoom: 'Zoom',
  inspection: 'Inspection',
  meeting: 'Meeting',
};

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: 'Scheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
  rescheduled: 'Rescheduled',
};

/**
 * Reminder choices, in minutes before the start. Sent by the cron tick to the
 * person who booked it, the agent it is assigned to and — once invited — the
 * contact (ADR 0032 §4).
 */
export const REMINDER_CHOICES = [
  { minutes: null, label: 'No reminder' },
  { minutes: 15, label: '15 minutes before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 1440, label: '1 day before' },
] as const;
const REMINDER_MINUTES = [15, 60, 1440] as const;
/** What a booking gets when it does not say (the assistant never does). "No reminder" is an explicit null. */
export const DEFAULT_REMINDER_MINUTES = 15;

/** Blank → undefined, so "" never reaches a nullable column. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const instant = z
  .string()
  .datetime({ offset: true, message: 'Pick a date and time' })
  .transform((v) => new Date(v));

export const MAX_ATTENDEES = 10;

const attendeeSchema = z.object({
  name: z.string().trim().min(1, 'Give each attendee a name').max(120),
  email: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v.toLowerCase() : null))
    .pipe(z.string().email('An attendee email does not look right').nullable()),
});

/**
 * Where it happens: an address or a link. `meetingUrl` must be http(s) — it
 * goes into an email as a link, and a `javascript:` one would be a hole.
 */
const placeFields = {
  location: optionalText(300),
  meetingUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(
      z
        .string()
        .url('The meeting link must be a full web address')
        .refine((u) => /^https?:\/\//i.test(u), 'The meeting link must start with https://')
        .optional(),
    ),
};

/**
 * Times arrive as instants: the browser turns what the agent typed, in THEIR
 * zone, into UTC before sending (`localDateTimeToInstant`), and sends that
 * zone with it. The server never interprets a wall-clock time.
 */
const timeFields = {
  startsAt: instant,
  endsAt: instant,
  timezone: z.string().refine(isValidTimeZone, 'Unknown timezone'),
};

const endsAfterStarts = (v: { startsAt: Date; endsAt: Date }) => v.endsAt.getTime() > v.startsAt.getTime();
const ENDS_MESSAGE = { message: 'The end time must be after the start time', path: ['endsAt'] };

export const scheduleAppointmentSchema = z
  .object({
    title: z.string().trim().min(1, 'Give it a title').max(160),
    type: z.enum(APPOINTMENT_TYPES),
    ...timeFields,
    ...placeFields,
    notes: optionalText(2000),
    propertyId: z.string().uuid().optional(),
    attendees: z.array(attendeeSchema).max(MAX_ATTENDEES).default([]),
    reminderMinutes: z
      .number()
      .int()
      .refine((m) => (REMINDER_MINUTES as readonly number[]).includes(m), 'Pick one of the reminder choices')
      .nullable()
      .default(DEFAULT_REMINDER_MINUTES),
    /** An admin may book it for somebody else; anybody else books for themselves. */
    assignedAgentId: z.string().uuid().optional(),
  })
  .refine(endsAfterStarts, ENDS_MESSAGE);
export type ScheduleAppointmentInput = z.input<typeof scheduleAppointmentSchema>;

export const rescheduleAppointmentSchema = z
  .object({ ...timeFields, outcome: optionalText(1000) })
  .refine(endsAfterStarts, ENDS_MESSAGE);
export type RescheduleAppointmentInput = z.input<typeof rescheduleAppointmentSchema>;

/** Completing or cancelling: what happened, in a sentence or two. */
export const finishAppointmentSchema = z.object({ outcome: optionalText(1000) });
export type FinishAppointmentInput = z.input<typeof finishAppointmentSchema>;

export const appointmentListQuerySchema = z.object({
  when: z.enum(['upcoming', 'past']).default('upcoming').catch('upcoming'),
  /** An admin's calendar may narrow to one agent. */
  agent: z.string().uuid().optional().catch(undefined),
});
export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;
