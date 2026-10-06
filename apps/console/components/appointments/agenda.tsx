'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  APPOINTMENT_STATUS_LABELS,
  APPOINTMENT_TYPE_LABELS,
  REMINDER_CHOICES,
} from '@repo/core/appointments/schema';
import { browserTimeZone, instantToLocalInput, localDateTimeToInstant } from '@repo/core/time';
import { useToast } from '@/components/toast';
import {
  cancelAppointmentAction,
  completeAppointmentAction,
  rescheduleAppointmentAction,
  retryAppointmentSyncAction,
} from '@/lib/appointment-actions';
import contactStyles from '@/components/contacts/contacts.module.css';
import { InvitationPreviewBox } from './invitation-preview';
import type { AppointmentItem } from './item';
import styles from './appointments.module.css';

/**
 * A list of appointments grouped by day — the day and the times as THIS
 * browser's clock reads them (the 2026-10-05 timezone rule). Grouping is done
 * here, after mount, because the server cannot know the viewer's zone; until
 * then the list is one block in UTC order, which is already the right order.
 *
 * Every button comes from `mayUpdate`, decided by can() on the server.
 */
export function Agenda({
  items,
  showContact,
  contactBasePath,
  emptyText,
}: {
  items: AppointmentItem[];
  /** On a calendar page, each item names and links its contact. */
  showContact: boolean;
  contactBasePath: string;
  emptyText: string;
}) {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => setZone(browserTimeZone()), []);

  const groups = useMemo(() => {
    if (!zone) return [{ key: 'all', label: '', items }];
    const day = new Intl.DateTimeFormat('en-AU', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const out: { key: string; label: string; items: AppointmentItem[] }[] = [];
    for (const it of items) {
      const label = day.format(new Date(it.startsAt));
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(it);
      else out.push({ key: `${label}-${it.id}`, label, items: [it] });
    }
    return out;
  }, [items, zone]);

  if (!items.length) return <p className={contactStyles.note}>{emptyText}</p>;

  return (
    <div className={styles.wrap}>
      {zone ? <span className={styles.zone}>Times shown in your timezone ({zone}).</span> : null}
      {groups.map((g) => (
        <section key={g.key} className={styles.day}>
          {g.label ? <h3 className={styles.dayHead}>{g.label}</h3> : null}
          {g.items.map((it) => (
            <AppointmentCard key={it.id} item={it} zone={zone} showContact={showContact} contactBasePath={contactBasePath} />
          ))}
        </section>
      ))}
    </div>
  );
}

function clock(iso: string, zone: string | null): string {
  if (!zone) return '';
  return new Intl.DateTimeFormat('en-AU', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

const BADGE: Record<string, string | undefined> = {
  rescheduled: styles.badgeMoved,
  completed: styles.badgeDone,
  cancelled: styles.badgeCancelled,
};

function AppointmentCard({
  item: a,
  zone,
  showContact,
  contactBasePath,
}: {
  item: AppointmentItem;
  zone: string | null;
  showContact: boolean;
  contactBasePath: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<null | 'complete' | 'cancel' | 'reschedule' | 'invite'>(null);
  const [outcome, setOutcome] = useState('');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const active = a.status === 'scheduled' || a.status === 'rescheduled';
  const over = new Date(a.endsAt).getTime() < Date.now();
  const reminder = REMINDER_CHOICES.find((r) => r.minutes === a.reminderMinutes);

  function openReschedule() {
    const tz = zone ?? browserTimeZone();
    const s = instantToLocalInput(a.startsAt, tz);
    const e = instantToLocalInput(a.endsAt, tz);
    setDate(s.slice(0, 10));
    setStart(s.slice(11));
    setEnd(e.slice(11));
    setOutcome('');
    setMode('reschedule');
  }

  function submit() {
    startTransition(async () => {
      let r: { ok: boolean; error?: string };
      if (mode === 'complete') r = await completeAppointmentAction(a.id, { outcome });
      else if (mode === 'cancel') r = await cancelAppointmentAction(a.id, { outcome });
      else {
        const tz = browserTimeZone();
        const s = localDateTimeToInstant(date, start, tz);
        const e = localDateTimeToInstant(date, end, tz);
        if (!s || !e) {
          toast({ title: 'Pick a date and both times', variant: 'error' });
          return;
        }
        r = await rescheduleAppointmentAction(a.id, {
          startsAt: s.toISOString(),
          endsAt: e.toISOString(),
          timezone: tz,
          outcome,
        });
      }
      if (!r.ok) {
        toast({ title: 'Not saved', description: r.error, variant: 'error' });
        return;
      }
      toast({ title: mode === 'complete' ? 'Completed' : mode === 'cancel' ? 'Cancelled' : 'Moved', variant: 'success' });
      setMode(null);
      router.refresh();
    });
  }

  return (
    <article className={styles.item}>
      <div className={styles.time}>
        {clock(a.startsAt, zone)}
        <span className={styles.timeEnd}>to {clock(a.endsAt, zone)}</span>
      </div>
      <div>
        <div className={styles.title}>
          {a.title}
          <span className={`${styles.badge} ${BADGE[a.status] ?? ''}`}>{APPOINTMENT_STATUS_LABELS[a.status]}</span>
        </div>
        <div className={styles.meta}>
          {APPOINTMENT_TYPE_LABELS[a.type]}
          {showContact ? (
            <>
              {' with '}
              <Link href={`${contactBasePath}/${a.contactId}?tab=calendar`}>{a.contactName}</Link>
            </>
          ) : null}
          {a.assignedAgentName ? ` · ${a.assignedAgentName}` : ''}
          {a.propertyAddress ? ` · ${a.propertyAddress}` : ''}
        </div>
        {a.location || (a.meetingUrl && !a.zoomMeeting) ? (
          <div className={styles.meta}>
            {a.location ? a.location : null}
            {a.location && a.meetingUrl && !a.zoomMeeting ? ' · ' : null}
            {a.meetingUrl && !a.zoomMeeting ? (
              <a href={a.meetingUrl} target="_blank" rel="noopener noreferrer">Meeting link ↗</a>
            ) : null}
          </div>
        ) : null}
        {a.zoomMeeting && a.meetingUrl && active && a.zoomSyncState !== 'removed' ? (
          <div className={styles.actions}>
            <a className={contactStyles.btnSmall} href={a.meetingUrl} target="_blank" rel="noopener noreferrer">Join Zoom ↗</a>
          </div>
        ) : null}
        <SyncStatus item={a} zone={zone} active={active} />
        {a.attendees.length ? (
          <div className={styles.meta}>Also: {a.attendees.map((p) => p.name).join(', ')}</div>
        ) : null}
        <div className={styles.meta}>
          {reminder && reminder.minutes ? `Reminder: ${reminder.label.toLowerCase()} · ` : ''}
          {a.invitationSentAt ? 'Invitation emailed' : active ? 'No invitation sent' : ''}
        </div>
        {a.notes ? <div className={styles.outcome}>Notes: {a.notes}</div> : null}
        {a.outcome ? <div className={styles.outcome}>Outcome: {a.outcome}</div> : null}

        {a.mayUpdate && active && mode === null ? (
          <div className={styles.actions}>
            <button type="button" className={contactStyles.btnSmall} onClick={() => { setOutcome(''); setMode('complete'); }}>Complete</button>
            <button type="button" className={contactStyles.btnSmall} onClick={openReschedule}>Reschedule</button>
            <button type="button" className={contactStyles.btnSmall} onClick={() => { setOutcome(''); setMode('cancel'); }}>Cancel</button>
            {!a.invitationSentAt && !over ? (
              <button type="button" className={contactStyles.btnSmall} onClick={() => setMode('invite')}>Email invitation…</button>
            ) : null}
          </div>
        ) : null}

        {mode === 'invite' ? <InvitationPreviewBox appointmentId={a.id} onDone={() => setMode(null)} /> : null}

        {mode === 'complete' || mode === 'cancel' || mode === 'reschedule' ? (
          <form
            className={styles.inlineForm}
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {mode === 'reschedule' ? (
              <div className={styles.three}>
                <input className={contactStyles.input} style={{ minWidth: 0 }} type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
                <input className={contactStyles.input} style={{ minWidth: 0 }} type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start" />
                <input className={contactStyles.input} style={{ minWidth: 0 }} type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End" />
              </div>
            ) : null}
            <textarea
              className={contactStyles.textarea}
              rows={2}
              maxLength={1000}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              placeholder={
                mode === 'complete' ? 'Outcome — what happened, what was agreed' : mode === 'cancel' ? 'Why it was cancelled' : 'Why it moved (optional)'
              }
              aria-label="Outcome note"
            />
            <div className={contactStyles.actions}>
              <button type="submit" className={contactStyles.btn} disabled={pending}>
                {pending ? 'Saving…' : mode === 'complete' ? 'Mark completed' : mode === 'cancel' ? 'Cancel appointment' : 'Move it'}
              </button>
              <button type="button" className={contactStyles.btnGhost} onClick={() => setMode(null)} disabled={pending}>Back</button>
            </div>
          </form>
        ) : null}
      </div>
    </article>
  );
}

function stamp(iso: string, zone: string | null): string {
  if (!zone) return '';
  return new Intl.DateTimeFormat('en-AU', { timeZone: zone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/**
 * How Google Calendar and Zoom stand for this appointment (Phase 3b). Our
 * record is the truth: a change made inside Google is shown here as a
 * conflict, and only a person decides — keep ours (push it back) or take
 * Google's time (an ordinary reschedule).
 */
function SyncStatus({ item: a, zone, active }: { item: AppointmentItem; zone: string | null; active: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) {
        toast({ title: 'Not done', description: r.error, variant: 'error' });
        return;
      }
      toast({ title: done, variant: 'success' });
      router.refresh();
    });
  }
  const retry = (label = 'Retry') =>
    a.mayUpdate ? (
      <button type="button" className={contactStyles.btnSmall} disabled={pending} onClick={() => run(() => retryAppointmentSyncAction(a.id), 'Synced again')}>
        {pending ? 'Working…' : label}
      </button>
    ) : null;

  const lines: React.ReactNode[] = [];

  if (a.zoomSyncState === 'pending') lines.push(<div key="zp" className={styles.meta}>Zoom · creating the meeting…</div>);
  if (a.zoomSyncState === 'failed') {
    lines.push(
      <div key="zf" className={styles.syncWarn} role="status">
        <span>⚠ Zoom — {a.zoomSyncError ?? 'not synced'}</span>
        {retry()}
      </div>,
    );
  }
  if (a.zoomMeeting && a.zoomSyncState === 'removed') lines.push(<div key="zr" className={styles.meta}>Zoom meeting deleted</div>);

  const c = a.calendarSyncState;
  if (c === 'synced' && a.calendarSyncedAt) {
    lines.push(<div key="cs" className={styles.meta}>Google Calendar · synced {stamp(a.calendarSyncedAt, zone)}</div>);
  } else if (c === 'pending') {
    lines.push(<div key="cp" className={styles.meta}>Google Calendar · syncing…</div>);
  } else if (c === 'removed') {
    lines.push(<div key="cr" className={styles.meta}>Removed from Google Calendar</div>);
  } else if (c === 'failed') {
    lines.push(
      <div key="cf" className={styles.syncWarn} role="status">
        <span>⚠ Google Calendar — not synced. {a.calendarSyncError ?? ''}</span>
        {retry()}
      </div>,
    );
  } else if (c === 'conflict' && a.calendarConflict) {
    const k = a.calendarConflict;
    const moved = !k.deleted && k.startsAt && k.endsAt;
    lines.push(
      <div key="cc" className={styles.syncWarn} role="status">
        <span>
          ⚠ Changed in Google Calendar:{' '}
          {k.deleted ? 'the event was deleted there.' : moved ? `moved to ${stamp(k.startsAt!, zone)} – ${clock(k.endsAt!, zone)}.` : 'it was edited there.'}{' '}
          This record was not changed.
        </span>
        {active ? retry(k.deleted ? 'Put it back in Google' : 'Keep ours') : null}
        {active && moved && a.mayUpdate ? (
          <button
            type="button"
            className={contactStyles.btnSmall}
            disabled={pending}
            onClick={() =>
              run(
                () => rescheduleAppointmentAction(a.id, { startsAt: k.startsAt!, endsAt: k.endsAt!, timezone: browserTimeZone(), outcome: 'Moved to the time set in Google Calendar' }),
                'Moved to Google’s time',
              )
            }
          >
            Use Google’s time
          </button>
        ) : null}
      </div>,
    );
  }
  return lines.length ? <>{lines}</> : null;
}
