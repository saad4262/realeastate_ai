'use client';

import { useState, useTransition } from 'react';
import { CALL_DIRECTION_LABELS, CALL_DIRECTIONS, CALL_OUTCOME_LABELS, CALL_OUTCOMES, MAX_CALL_NOTE_LENGTH, logCallSchema } from '@repo/core/contacts/schema';
import { logCallAction, summarizeContactAction } from '@/lib/contact-actions';
import { useRun } from './islands';
import styles from './contacts.module.css';

/** Log a call the platform could not see (ADR 0083). The action validates and asks can() again. */
export function LogCallForm({ contactId }: { contactId: string }) {
  const { pending, run } = useRun();
  const [direction, setDirection] = useState<(typeof CALL_DIRECTIONS)[number]>('out');
  const [outcome, setOutcome] = useState<(typeof CALL_OUTCOMES)[number]>('answered');
  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      style={{ display: 'grid', gap: '0.5rem' }}
      onSubmit={(e) => {
        e.preventDefault();
        const input = { direction, outcome, minutes: minutes === '' ? null : Number(minutes), note };
        const check = logCallSchema.safeParse(input);
        if (!check.success) {
          setError('Minutes must be a whole number up to 600.');
          return;
        }
        setError(null);
        run(() => logCallAction(contactId, input), 'Call saved', () => {
          setMinutes('');
          setNote('');
        });
      }}
    >
      <div className={styles.inlineFields}>
        <select className={styles.select} value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} aria-label="Direction">
          {CALL_DIRECTIONS.map((d) => <option key={d} value={d}>{CALL_DIRECTION_LABELS[d]}</option>)}
        </select>
        <select className={styles.select} value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} aria-label="Result">
          {CALL_OUTCOMES.map((o) => <option key={o} value={o}>{CALL_OUTCOME_LABELS[o]}</option>)}
        </select>
        <input className={`${styles.select} ${styles.minutes}`} type="number" min={0} max={600} step={1} inputMode="numeric" placeholder="Minutes" aria-label="Minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </div>
      <textarea className={styles.textarea} rows={3} maxLength={MAX_CALL_NOTE_LENGTH} placeholder="What you talked about" aria-label="What you talked about" value={note} onChange={(e) => setNote(e.target.value)} />
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div><button type="submit" className={styles.btn} disabled={pending}>{pending ? 'Saving…' : 'Save call'}</button></div>
    </form>
  );
}

/** The one model-written text on a profile: on a button, labelled, gone when the page reloads (ADR 0083, #7). */
export function SummaryButton({ contactId }: { contactId: string }) {
  const [pending, start] = useTransition();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ display: 'grid', gap: '0.5rem', justifyItems: 'start' }}>
      {text ? (
        <div className={styles.aiText}>
          <span><span className={styles.chipAi}>Written by AI, check it first</span></span>
          <span>{text}</span>
        </div>
      ) : (
        <p className={styles.sub}>What they want and how they get in touch, in a few sentences from their history.</p>
      )}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <button
        type="button"
        className={styles.btnGhost}
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await summarizeContactAction(contactId);
            if (r.ok) setText(r.text);
            else setError(r.error);
          })
        }
      >
        {pending ? 'Writing…' : text ? 'Write it again' : 'Write a summary'}
      </button>
    </div>
  );
}
