import type { AppointmentView } from '@repo/core/appointments';

/** An appointment as it crosses to the browser: instants as ISO strings. */
export type AppointmentItem = Omit<AppointmentView, 'startsAt' | 'endsAt' | 'invitationSentAt' | 'calendarSyncedAt'> & {
  startsAt: string;
  endsAt: string;
  invitationSentAt: string | null;
  calendarSyncedAt: string | null;
};

export function toItem(v: AppointmentView): AppointmentItem {
  return {
    ...v,
    startsAt: v.startsAt.toISOString(),
    endsAt: v.endsAt.toISOString(),
    invitationSentAt: v.invitationSentAt ? v.invitationSentAt.toISOString() : null,
    calendarSyncedAt: v.calendarSyncedAt ? v.calendarSyncedAt.toISOString() : null,
  };
}
