'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  APPOINTMENT_TYPE_LABELS,
  APPOINTMENT_TYPES,
  DEFAULT_REMINDER_MINUTES,
  MAX_ATTENDEES,
  REMINDER_CHOICES,
  scheduleAppointmentSchema,
  type AppointmentType,
} from '@repo/core/appointments/schema';
import { browserTimeZone, instantToLocalInput, localDateTimeToInstant } from '@repo/core/time';
import { useToast } from '@/components/toast';
import { scheduleAppointmentAction } from '@/lib/appointment-actions';
import contactStyles from '@/components/contacts/contacts.module.css';
import { InvitationPreviewBox } from './invitation-preview';
import styles from './appointments.module.css';

/**
 * "Schedule" — the side panel on a contact's Calendar tab (ADR 0019).
 *
 * The agent types the date and times on THEIR clock; this component turns
 * them into instants with the browser's own zone (`localDateTimeToInstant`)
 * and sends the zone with them. The server never reads a wall-clock time.
 *
 * "Send invitation" is OFF by default. When ticked, booking does NOT email:
 * it opens the exact preview, and only its Send button sends.
 *
 * Type Zoom (Phase 3b): with a Zoom usable (the agent's own, else the
 * agency's — `requireIntegrations` on the server) the meeting is created on
 * booking; without one, "Connect Zoom first", and Book waits unless a link of
 * their own is pasted. The server checks the same thing again.
 */
export function SchedulePanel({
  contactId,
  contactHasEmail,
  properties,
  assignees,
  zoom,
}: {
  /** What requireIntegrations said about Zoom for this person, and where to fix it. */
  zoom: { state: string; ownerType: 'user' | 'agency' | null; accountLabel: string | null; integrationsPath: string };
  contactId: string;
  contactHasEmail: boolean;
  /** This contact's properties, for "related property". */
  properties: { propertyId: string; address: string }[];
  /** Members it may be booked for. Empty unless this actor may assign (can()). */
  assignees: { userId: string; name: string }[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<string | null>(null);
  const [zone, setZone] = useState('');

  const [title, setTitle] = useState('');
  const [type, setType] = useState<AppointmentType>('appraisal');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('11:00');
  const [location, setLocation] = useState('');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [reminder, setReminder] = useState<string>(String(DEFAULT_REMINDER_MINUTES));
  const [propertyId, setPropertyId] = useState('');
  const [notes, setNotes] = useState('');
  const [assignee, setAssignee] = useState('');
  const [attendees, setAttendees] = useState<{ name: string; email: string }[]>([]);
  const [invite, setInvite] = useState(false);

  useEffect(() => {
    if (!open) return;
    const tz = browserTimeZone();
    setZone(tz);
    // Tomorrow, on this browser's calendar.
    if (!date) setDate(instantToLocalInput(new Date(Date.now() + 86_400_000), tz).slice(0, 10));
  }, [open, date]);

  function reset() {
    setTitle('');
    setType('appraisal');
    setDate('');
    setStart('10:00');
    setEnd('11:00');
    setLocation('');
    setMeetingUrl('');
    setReminder(String(DEFAULT_REMINDER_MINUTES));
    setPropertyId('');
    setNotes('');
    setAssignee('');
    setAttendees([]);
    setInvite(false);
    setError(null);
    setBooked(null);
  }

  function close() {
    setOpen(false);
    reset();
  }

  const zoomReady = zoom.state === 'connected';
  const zoomBlocked = type === 'zoom' && !zoomReady && !meetingUrl.trim();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (zoomBlocked) {
      setError('Connect Zoom first, or paste a meeting link of your own');
      return;
    }
    const tz = browserTimeZone();
    const s = localDateTimeToInstant(date, start, tz);
    const en = localDateTimeToInstant(date, end, tz);
    if (!s || !en) {
      setError('Pick a date and both times');
      return;
    }
    const input = {
      title,
      type,
      startsAt: s.toISOString(),
      endsAt: en.toISOString(),
      timezone: tz,
      location,
      meetingUrl,
      notes,
      attendees: attendees.filter((a) => a.name.trim() || a.email.trim()),
      reminderMinutes: reminder ? Number(reminder) : null,
      ...(propertyId ? { propertyId } : {}),
      ...(assignee ? { assignedAgentId: assignee } : {}),
    };
    const check = scheduleAppointmentSchema.safeParse(input);
    if (!check.success) {
      setError(check.error.issues[0]?.message ?? 'Check the fields');
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await scheduleAppointmentAction(contactId, input);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast({ title: 'Appointment booked', variant: 'success' });
      router.refresh();
      if (invite) setBooked(r.id);
      else close();
    });
  }

  if (!open) {
    return (
      <button type="button" className={contactStyles.btn} onClick={() => setOpen(true)}>
        + Schedule
      </button>
    );
  }

  return (
    <>
      <div className={styles.scrim} onClick={close} aria-hidden />
      <aside className={styles.panel} role="dialog" aria-modal="true" aria-label="Schedule an appointment">
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>{booked ? 'Send the invitation?' : 'Schedule'}</h2>
          <button type="button" className={styles.close} onClick={close} aria-label="Close">✕</button>
        </div>

        {booked ? (
          <>
            <p className={contactStyles.note}>Booked. This is exactly what the contact will receive — nothing is sent until you press Send.</p>
            <InvitationPreviewBox appointmentId={booked} onDone={close} />
          </>
        ) : (
          <form className={contactStyles.form} style={{ padding: 0 }} onSubmit={submit} noValidate>
            {error ? <p className={contactStyles.error} role="alert">{error}</p> : null}
            <label className={contactStyles.field}>
              <span className={contactStyles.label}>Title</span>
              <input className={contactStyles.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="Appraisal at 12 Henry St" />
            </label>
            <label className={contactStyles.field}>
              <span className={contactStyles.label}>Type</span>
              <select className={contactStyles.select} value={type} onChange={(e) => setType(e.target.value as AppointmentType)}>
                {APPOINTMENT_TYPES.map((t) => (
                  <option key={t} value={t}>{APPOINTMENT_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </label>
            <div className={styles.three}>
              <label className={contactStyles.field}>
                <span className={contactStyles.label}>Date</span>
                <input className={contactStyles.input} style={{ minWidth: 0 }} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <label className={contactStyles.field}>
                <span className={contactStyles.label}>Start</span>
                <input className={contactStyles.input} style={{ minWidth: 0 }} type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <label className={contactStyles.field}>
                <span className={contactStyles.label}>End</span>
                <input className={contactStyles.input} style={{ minWidth: 0 }} type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
            </div>
            <span className={contactStyles.hint}>Times in your timezone{zone ? ` (${zone})` : ''}.</span>

            <label className={contactStyles.field}>
              <span className={contactStyles.label}>Location</span>
              <input className={contactStyles.input} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={300} placeholder="Address, office, or 'by phone'" />
            </label>
            <label className={contactStyles.field}>
              <span className={contactStyles.label}>Meeting link</span>
              <input className={contactStyles.input} type="url" value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} maxLength={500} placeholder={type === 'zoom' && zoomReady ? 'Leave empty — Zoom creates the link' : 'https://… (paste a Zoom or Meet link)'} />
              {type === 'zoom' && zoomReady ? (
                <span className={contactStyles.hint}>
                  A Zoom meeting is created when you book, on {zoom.ownerType === 'agency' ? 'the agency’s Zoom' : 'your Zoom'}
                  {zoom.accountLabel ? ` (${zoom.accountLabel})` : ''}. Paste a link only to use your own instead.
                </span>
              ) : type !== 'zoom' ? (
                <span className={contactStyles.hint}>Optional — paste a Meet or other link.</span>
              ) : null}
            </label>
            {type === 'zoom' && !zoomReady ? (
              <div className={contactStyles.error} role="status">
                {zoom.state === 'expired'
                  ? 'Zoom needs reconnecting. '
                  : zoom.state === 'permission_missing'
                    ? 'Zoom is connected without every permission it needs — reconnect it. '
                    : 'Connect Zoom first — you have no Zoom connected, and neither does the agency. '}
                <a href={zoom.integrationsPath}>Open Integrations</a>, or paste a meeting link above.
              </div>
            ) : null}

            {properties.length ? (
              <label className={contactStyles.field}>
                <span className={contactStyles.label}>Related property</span>
                <select className={contactStyles.select} value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
                  <option value="">None</option>
                  {properties.map((p) => (
                    <option key={p.propertyId} value={p.propertyId}>{p.address}</option>
                  ))}
                </select>
              </label>
            ) : null}

            <fieldset className={contactStyles.field} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className={contactStyles.label}>Other attendees</legend>
              {attendees.map((a, i) => (
                <div key={i} className={styles.attendee}>
                  <input className={contactStyles.input} style={{ minWidth: 0 }} value={a.name} placeholder="Name" aria-label={`Attendee ${i + 1} name`}
                    onChange={(e) => setAttendees((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <input className={contactStyles.input} style={{ minWidth: 0 }} type="email" value={a.email} placeholder="Email (optional)" aria-label={`Attendee ${i + 1} email`}
                    onChange={(e) => setAttendees((list) => list.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                  <button type="button" className={contactStyles.linkBtn} aria-label="Remove attendee"
                    onClick={() => setAttendees((list) => list.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              {attendees.length < MAX_ATTENDEES ? (
                <button type="button" className={contactStyles.linkBtn} onClick={() => setAttendees((l) => [...l, { name: '', email: '' }])}>
                  + Add attendee
                </button>
              ) : null}
            </fieldset>

            <label className={contactStyles.field}>
              <span className={contactStyles.label}>Reminder</span>
              <select className={contactStyles.select} value={reminder} onChange={(e) => setReminder(e.target.value)}>
                {REMINDER_CHOICES.map((r) => (
                  <option key={r.label} value={r.minutes ?? ''}>{r.label}</option>
                ))}
              </select>
              <span className={contactStyles.hint}>You, the agent and — once invited — the contact get a reminder.</span>
            </label>

            {assignees.length ? (
              <label className={contactStyles.field}>
                <span className={contactStyles.label}>Agent</span>
                <select className={contactStyles.select} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                  <option value="">Me</option>
                  {assignees.map((a) => (
                    <option key={a.userId} value={a.userId}>{a.name}</option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className={contactStyles.field}>
              <span className={contactStyles.label}>Notes (internal)</span>
              <textarea className={contactStyles.textarea} rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Only your agency sees these — never in the invitation." />
            </label>

            <label className={contactStyles.check}>
              <input type="checkbox" checked={invite} disabled={!contactHasEmail} onChange={(e) => setInvite(e.target.checked)} />
              Send invitation email to the contact
              {!contactHasEmail ? <span className={contactStyles.hint}> (no email on file)</span> : null}
            </label>

            <div className={contactStyles.actions}>
              <button type="submit" className={contactStyles.btn} disabled={pending || zoomBlocked}>
                {pending ? 'Booking…' : invite ? 'Book and preview invitation' : 'Book'}
              </button>
              <button type="button" className={contactStyles.btnGhost} onClick={close} disabled={pending}>Cancel</button>
            </div>
          </form>
        )}
      </aside>
    </>
  );
}
