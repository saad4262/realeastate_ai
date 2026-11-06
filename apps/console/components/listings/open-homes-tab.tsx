'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type FormEvent } from 'react';
import {
  MAX_REPEAT_WEEKS,
  OPEN_HOME_KINDS,
  OPEN_HOME_LABEL,
  openHomeDay,
  openHomeRange,
  openHomeSlots,
  type OpenHomeKind,
} from '@repo/core/inspections/open-home-rules';
import { instantToLocalInput } from '@repo/core/time';
import { addOpenHomesAction, copyOpenHomeNextWeekAction, removeOpenHomeAction, updateOpenHomeAction, type OpenHomeResult } from '@/lib/open-home-actions';
import styles from './open-homes-tab.module.css';

type Row = { id: string; kind: OpenHomeKind; startsAt: string; endsAt: string };

const LENGTHS = [15, 30, 45, 60];
const ON_MARKET = ['live', 'under_offer'];
const NOT_YET = ['draft', 'pending'];

function statusLine(status: string): { text: string; wait: boolean } {
  if (ON_MARKET.includes(status)) return { text: 'This listing is live. Changes show on the public page straight away.', wait: false };
  if (NOT_YET.includes(status)) return { text: "This listing isn't public yet. Times are saved and show once it's published.", wait: true };
  return { text: `This listing is ${status}. Its upcoming times are hidden from buyers, and they return if it goes live again.`, wait: true };
}

const slot = (r: Row) => ({ startsAt: new Date(r.startsAt), endsAt: new Date(r.endsAt) });

/**
 * A listing's Open homes tab (ADR 0081; mock docs/mocks/open-home-entry.html#tab). Times are typed and read on the property's clock,
 * whoever is at the keyboard. The rules here only preview: the server decides.
 */
export function OpenHomesTab(props: { listingId: string; status: string; timeZone: string; place: string; firstDate: string; upcoming: Row[]; past: Row[]; pastCount: number }) {
  const { listingId, timeZone, place } = props;
  const router = useRouter();
  const [busy, start] = useTransition();
  const [adding, setAdding] = useState(props.upcoming.length === 0);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const line = statusLine(props.status);

  function rowAction(action: () => Promise<OpenHomeResult>) {
    setRowError(null);
    start(async () => {
      const r = await action();
      if (r.ok) setRemoving(null);
      else setRowError(r.error);
      router.refresh();
    });
  }

  return (
    <div className={styles.tab}>
      <p className={`${styles.status} ${line.wait ? styles.wait : ''}`}>{line.text}</p>
      <section className={styles.card} aria-labelledby="open-homes-upcoming">
        <div className={styles.head}>
          <div>
            <h2 id="open-homes-upcoming" className={styles.title}>{props.upcoming.length ? 'Upcoming' : 'No open homes yet'}</h2>
            <p className={styles.sub}>All times are {place} time, where the property is.</p>
          </div>
          {adding ? null : <button type="button" className={styles.primary} onClick={() => { setEditing(null); setAdding(true); }}>Add a time</button>}
        </div>
        {props.upcoming.length ? null : <p className={styles.sub}>Buyers currently see &quot;No times scheduled&quot; on this listing, and it can&apos;t be added to their inspection plan.</p>}
        {adding ? <TimeForm listingId={listingId} timeZone={timeZone} initial={{ kind: 'open', date: props.firstDate, start: '10:00', minutes: 30 }} onDone={() => setAdding(false)} onCancel={props.upcoming.length ? () => setAdding(false) : null} /> : null}
        {rowError ? <p className={styles.error} role="alert">{rowError}</p> : null}
        <ul className={styles.times}>
          {props.upcoming.map((r) => (
            <li key={r.id} className={styles.time}>
              <span className={styles.day}>{openHomeDay(new Date(r.startsAt), timeZone)}</span>
              <span className={styles.when}>{openHomeRange(slot(r), timeZone)} <span className={`${styles.chip} ${styles[r.kind]}`}>{OPEN_HOME_LABEL[r.kind]}</span></span>
              <span className={styles.acts}>
                <button type="button" className={styles.ghost} disabled={busy} onClick={() => { setAdding(false); setEditing(r.id); }}>Edit</button>
                {r.kind === 'auction' ? null : <button type="button" className={styles.ghost} disabled={busy} onClick={() => rowAction(() => copyOpenHomeNextWeekAction(listingId, r.id))}>Next week</button>}
                <button type="button" className={styles.ghost} disabled={busy} onClick={() => setRemoving(r.id)}>Remove</button>
              </span>
              {removing === r.id ? (
                <div className={styles.confirm}>
                  <p><b>Remove this time?</b> It leaves the public page straight away. Anyone who already saved it to their own calendar keeps the old time.</p>
                  <span className={styles.acts}>
                    <button type="button" className={styles.danger} disabled={busy} onClick={() => rowAction(() => removeOpenHomeAction(listingId, r.id))}>Remove</button>
                    <button type="button" className={styles.ghost} disabled={busy} onClick={() => setRemoving(null)}>Keep it</button>
                  </span>
                </div>
              ) : null}
              {editing === r.id ? (
                <div className={styles.full}>
                  <TimeForm
                    listingId={listingId}
                    timeZone={timeZone}
                    editId={r.id}
                    initial={{ kind: r.kind, date: instantToLocalInput(r.startsAt, timeZone).slice(0, 10), start: instantToLocalInput(r.startsAt, timeZone).slice(11), minutes: Math.round((Date.parse(r.endsAt) - Date.parse(r.startsAt)) / 60_000) }}
                    onDone={() => setEditing(null)}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      {props.pastCount ? (
        <details className={styles.card}>
          <summary className={styles.title}>Past times ({props.pastCount})</summary>
          <p className={styles.sub}>Kept for reference on this screen only. Buyers never see them.</p>
          <ul className={styles.times}>
            {props.past.map((r) => (
              <li key={r.id} className={styles.time}>
                <span className={styles.day}>{openHomeDay(new Date(r.startsAt), timeZone)}</span>
                <span className={styles.when}>{openHomeRange(slot(r), timeZone)} <span className={`${styles.chip} ${styles[r.kind]}`}>{OPEN_HOME_LABEL[r.kind]}</span></span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function minutesBetween(start: string, end: string): number {
  const at = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) ? at(end) - at(start) : 0;
}

function TimeForm(props: { listingId: string; timeZone: string; editId?: string; initial: { kind: OpenHomeKind; date: string; start: string; minutes: number }; onDone: () => void; onCancel: (() => void) | null }) {
  const { listingId, timeZone, editId, initial } = props;
  const router = useRouter();
  const [busy, start] = useTransition();
  const [kind, setKind] = useState<OpenHomeKind>(initial.kind);
  const [date, setDate] = useState(initial.date);
  const [from, setFrom] = useState(initial.start);
  const [minutes, setMinutes] = useState(initial.minutes);
  const [useEnd, setUseEnd] = useState(!LENGTHS.includes(initial.minutes));
  const [end, setEnd] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [weeks, setWeeks] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);

  const length = useEnd && end ? minutesBetween(from, end) : minutes;
  const canRepeat = !editId && kind !== 'auction';
  const count = canRepeat && repeat ? weeks : 1;
  const preview = useMemo(() => {
    if (length <= 0) return [];
    return openHomeSlots({ date, start: from, minutes: length, weeks: count }, timeZone) ?? [];
  }, [date, from, length, count, timeZone]);

  function send(confirmedHours: boolean) {
    setError(null);
    setQuestion(null);
    const input = { kind, date, start: from, minutes: length, weeks: count, confirmedHours };
    start(async () => {
      const r = editId ? await updateOpenHomeAction(listingId, editId, input) : await addOpenHomesAction(listingId, input);
      if (r.ok) {
        props.onDone();
        router.refresh();
      } else if (r.confirm) setQuestion(r.error);
      else setError(r.error);
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send(false);
  }

  const noun = OPEN_HOME_LABEL[kind].toLowerCase();
  return (
    <form className={styles.form} onSubmit={onSubmit} aria-label={editId ? 'Change this time' : 'Add a time'}>
      <fieldset className={`${styles.field} ${styles.span}`}>
        <legend className={styles.label}>Type</legend>
        <div className={styles.seg}>
          {OPEN_HOME_KINDS.map((k) => (
            <button key={k} type="button" className={`${styles.segBtn} ${kind === k ? styles.segOn : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{OPEN_HOME_LABEL[k]}</button>
          ))}
        </div>
      </fieldset>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="open-home-date">Day</label>
        <input id="open-home-date" className={styles.input} type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="open-home-start">Starts</label>
        <input id="open-home-start" className={styles.input} type="time" required value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <fieldset className={styles.field}>
        <legend className={styles.label}>How long</legend>
        <div className={styles.seg}>
          {LENGTHS.map((m) => (
            <button key={m} type="button" className={`${styles.segBtn} ${!useEnd && minutes === m ? styles.segOn : ''}`} aria-pressed={!useEnd && minutes === m} onClick={() => { setUseEnd(false); setMinutes(m); }}>{m === 60 ? '60 min' : m}</button>
          ))}
          <button type="button" className={`${styles.segBtn} ${useEnd ? styles.segOn : ''}`} aria-pressed={useEnd} onClick={() => setUseEnd(true)}>End time</button>
        </div>
        {useEnd ? <input aria-label="Ends at" className={styles.input} type="time" required={!editId} value={end} onChange={(e) => setEnd(e.target.value)} /> : null}
      </fieldset>
      {canRepeat ? (
        <div className={`${styles.field} ${styles.span}`}>
          <label className={styles.check}>
            <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Repeat weekly
          </label>
          {repeat ? (
            <label className={styles.check}>
              for
              <select className={styles.input} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
                {Array.from({ length: MAX_REPEAT_WEEKS - 1 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n} weeks</option>)}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      {preview.length > 1 ? (
        <div className={`${styles.preview} ${styles.span}`}>
          <b>This adds {preview.length} {noun === 'by appointment' ? 'times' : `${noun}s`}</b>
          <ul>{preview.map((s) => <li key={s.startsAt.toISOString()}>{openHomeDay(s.startsAt, timeZone)}, {openHomeRange(s, timeZone)}</li>)}</ul>
        </div>
      ) : null}
      {error ? <p className={`${styles.error} ${styles.span}`} role="alert">{error}</p> : null}
      {question ? (
        <div className={`${styles.confirm} ${styles.span}`} role="alert">
          <p>{question}</p>
          <span className={styles.acts}>
            <button type="button" className={styles.primary} disabled={busy} onClick={() => send(true)}>Yes, save it</button>
            <button type="button" className={styles.ghost} disabled={busy} onClick={() => setQuestion(null)}>Change it</button>
          </span>
        </div>
      ) : null}
      <div className={`${styles.acts} ${styles.span}`}>
        <button type="submit" className={styles.primary} disabled={busy}>{editId ? 'Save' : count > 1 ? `Add ${count} times` : 'Add this time'}</button>
        {props.onCancel ? <button type="button" className={styles.ghost} disabled={busy} onClick={props.onCancel}>Cancel</button> : null}
      </div>
    </form>
  );
}
