'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  APPOINTMENT_TYPE_LABELS,
  DEFAULT_REMINDER_MINUTES,
  MAX_TEAM_PARTICIPANTS,
  REMINDER_CHOICES,
  scheduleTeamMeetingSchema,
  TEAM_MEETING_TYPES,
} from '@repo/core/appointments/schema';
import { browserTimeZone, instantToLocalInput, localDateTimeToInstant } from '@repo/core/time';
import { useToast } from '@/components/toast';
import { scheduleTeamMeetingAction } from '@/lib/appointment-actions';
import contactStyles from '@/components/contacts/contacts.module.css';
import styles from './appointments.module.css';

type TeamMeetingType = (typeof TEAM_MEETING_TYPES)[number];

/**
 * "+ Team meeting" on the calendar (ADR 0038): a meeting with colleagues
 * instead of a contact. Same clock rule as the Schedule panel — the times are
 * typed on THIS browser's clock and sent as instants with the zone.
 *
 * Booking tells everyone: the server books it, makes the Zoom meeting, then
 * emails each person the link and an .ics. If Zoom fails, nobody is emailed
 * until Retry on the calendar works — the panel says so.
 */
export function TeamMeetingPanel({
  colleagues,
  hosts,
  zoom,
}: {
  /** Every other active member, from listColleagues. */
  colleagues: { userId: string; name: string; roleLabel: string }[];
  /** Members an admin may make the host. Empty unless this actor may assign (can()). */
  hosts: { userId: string; name: string }[];
  /** What requireIntegrations said about Zoom for this person, and where to fix it. */
  zoom: { state: string; ownerType: 'user' | 'agency' | null; accountLabel: string | null; integrationsPath: string };
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [zone, setZone] = useState('');

  const [title, setTitle] = useState('');
  const [type, setType] = useState<TeamMeetingType>('zoom');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('10:30');
  const [location, setLocation] = useState('');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [reminder, setReminder] = useState<string>(String(DEFAULT_REMINDER_MINUTES));
  const [notes, setNotes] = useState('');
  const [host, setHost] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!open) return;
    const tz = browserTimeZone();
    setZone(tz);
    if (!date) setDate(instantToLocalInput(new Date(Date.now() + 86_400_000), tz).slice(0, 10));
  }, [open, date]);

  function close() {
    setOpen(false);
    setTitle('');
    setType('zoom');
    setDate('');
    setStart('10:00');
    setEnd('10:30');
    setLocation('');
    setMeetingUrl('');
    setReminder(String(DEFAULT_REMINDER_MINUTES));
    setNotes('');
    setHost('');
    setPicked([]);
    setFilter('');
    setError(null);
  }

  const zoomReady = zoom.state === 'connected';
  // An admin hosting it for somebody else: that person's Zoom is checked on the server.
  const zoomBlocked = type === 'zoom' && !host && !zoomReady && !meetingUrl.trim();
  const shown = colleagues.filter((c) => !filter.trim() || c.name.toLowerCase().includes(filter.trim().toLowerCase()));

  function toggle(id: string) {
    setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : list.length >= MAX_TEAM_PARTICIPANTS ? list : [...list, id]));
  }

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
      participantIds: picked,
      reminderMinutes: reminder ? Number(reminder) : null,
      ...(host ? { hostId: host } : {}),
    };
    const check = scheduleTeamMeetingSchema.safeParse(input);
    if (!check.success) {
      setError(check.error.issues[0]?.message ?? 'Check the fields');
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await scheduleTeamMeetingAction(input);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.told) toast({ title: 'Team meeting booked', description: 'Everyone on it was sent the details and the link.', variant: 'success' });
      else toast({ title: 'Booked — nobody emailed yet', description: `${r.zoomError ?? 'The Zoom meeting was not created.'} Press Retry on the calendar; they are emailed once it works.`, variant: 'warning' });
      router.refresh();
      close();
    });
  }

  if (!open) {
    return (
      <button type="button" className={contactStyles.btn} onClick={() => setOpen(true)} disabled={!colleagues.length} title={colleagues.length ? undefined : 'There is nobody else in your agency yet'}>
        + Team meeting
      </button>
    );
  }

  return (
    <>
      <div className={styles.scrim} onClick={close} aria-hidden />
      <aside className={styles.panel} role="dialog" aria-modal="true" aria-label="Book a team meeting">
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Team meeting</h2>
          <button type="button" className={styles.close} onClick={close} aria-label="Close">✕</button>
        </div>

        <form className={contactStyles.form} style={{ padding: 0 }} onSubmit={submit} noValidate>
          {error ? <p className={contactStyles.error} role="alert">{error}</p> : null}
          <label className={contactStyles.field}>
            <span className={contactStyles.label}>Title</span>
            <input className={contactStyles.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="Weekly listings sync" />
          </label>

          <fieldset className={contactStyles.field} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className={contactStyles.label}>
              Colleagues ({picked.length}/{MAX_TEAM_PARTICIPANTS})
            </legend>
            {colleagues.length > 6 ? (
              <input className={contactStyles.input} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find by name" aria-label="Find a colleague" />
            ) : null}
            <div className={styles.picker}>
              {shown.map((c) => (
                <label key={c.userId} className={contactStyles.check}>
                  <input type="checkbox" checked={picked.includes(c.userId)} onChange={() => toggle(c.userId)} disabled={!picked.includes(c.userId) && picked.length >= MAX_TEAM_PARTICIPANTS} />
                  {c.name} <span className={contactStyles.hint}>· {c.roleLabel}</span>
                </label>
              ))}
            </div>
            <span className={contactStyles.hint}>Each one gets a notification and an email with the time, the link and a calendar file.</span>
          </fieldset>

          <label className={contactStyles.field}>
            <span className={contactStyles.label}>Type</span>
            <select className={contactStyles.select} value={type} onChange={(e) => setType(e.target.value as TeamMeetingType)}>
              {TEAM_MEETING_TYPES.map((t) => (
                <option key={t} value={t}>{t === 'meeting' ? 'In person' : APPOINTMENT_TYPE_LABELS[t]}</option>
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
          <span className={contactStyles.hint}>Times in your timezone{zone ? ` (${zone})` : ''}. Everyone sees them in their own.</span>

          {type === 'zoom' ? (
            <label className={contactStyles.field}>
              <span className={contactStyles.label}>Meeting link</span>
              <input className={contactStyles.input} type="url" value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} maxLength={500} placeholder={zoomReady || host ? 'Leave empty — Zoom creates the link' : 'https://… (paste a link of your own)'} />
              {!host && zoomReady ? (
                <span className={contactStyles.hint}>
                  The meeting is created on {zoom.ownerType === 'agency' ? 'the agency’s Zoom' : 'your Zoom'}
                  {zoom.accountLabel ? ` (${zoom.accountLabel})` : ''}; you are its host.
                </span>
              ) : null}
            </label>
          ) : (
            <label className={contactStyles.field}>
              <span className={contactStyles.label}>{type === 'phone_call' ? 'Dial-in or number' : 'Where'}</span>
              <input className={contactStyles.input} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={300} placeholder={type === 'phone_call' ? '02 9999 0000' : 'Office, meeting room'} />
            </label>
          )}
          {zoomBlocked ? (
            <div className={contactStyles.error} role="status">
              {zoom.state === 'expired'
                ? 'Zoom needs reconnecting. '
                : zoom.state === 'permission_missing'
                  ? 'Zoom is connected without every permission it needs — reconnect it. '
                  : 'Connect Zoom first — you have no Zoom connected, and neither does the agency. '}
              <a href={zoom.integrationsPath}>Open Connectors</a>, or paste a meeting link above.
            </div>
          ) : null}

          <label className={contactStyles.field}>
            <span className={contactStyles.label}>Agenda</span>
            <textarea className={contactStyles.textarea} rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Shown to everyone on the meeting." />
          </label>

          <label className={contactStyles.field}>
            <span className={contactStyles.label}>Reminder</span>
            <select className={contactStyles.select} value={reminder} onChange={(e) => setReminder(e.target.value)}>
              {REMINDER_CHOICES.map((r) => (
                <option key={r.label} value={r.minutes ?? ''}>{r.label}</option>
              ))}
            </select>
            <span className={contactStyles.hint}>Everyone who has not declined gets it: in the console and by email.</span>
          </label>

          {hosts.length ? (
            <label className={contactStyles.field}>
              <span className={contactStyles.label}>Host</span>
              <select className={contactStyles.select} value={host} onChange={(e) => setHost(e.target.value)}>
                <option value="">Me</option>
                {hosts.map((h) => (
                  <option key={h.userId} value={h.userId}>{h.name}</option>
                ))}
              </select>
              <span className={contactStyles.hint}>The Zoom meeting is created on the host’s Zoom (or the agency’s).</span>
            </label>
          ) : null}

          <div className={contactStyles.actions}>
            <button type="submit" className={contactStyles.btn} disabled={pending || zoomBlocked || !picked.length}>
              {pending ? 'Booking…' : 'Book and tell everyone'}
            </button>
            <button type="button" className={contactStyles.btnGhost} onClick={close} disabled={pending}>Cancel</button>
          </div>
        </form>
      </aside>
    </>
  );
}
