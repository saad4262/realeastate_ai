'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { markMissedCallHandledAction, saveMissedCallSettingsAction } from '@/lib/phone-actions';
import styles from './phone.module.css';

/** "Mark as handled" on a missed call (ADR 0071). The server checks it is theirs, or they are an owner or admin. */
export function HandledButton({ callId, handled }: { callId: string; handled: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className={handled ? styles.btn : styles.btnPrimary}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await markMissedCallHandledAction(callId, !handled);
          if (!r.ok) {
            toast({ title: 'Not changed', description: r.error, variant: 'error' });
            return;
          }
          router.refresh();
        })
      }
    >
      {handled ? 'Mark as not handled' : 'Mark as handled'}
    </button>
  );
}

const SAMPLE = { first_name: 'John', agent_first_name: 'Sarah', agency_name: 'your agency' };
const preview = (t: string, agencyName: string) =>
  t.replace(/\{\{\s*(first_name|agent_first_name|agency_name)\s*\}\}/g, (_, f: keyof typeof SAMPLE) => (f === 'agency_name' ? agencyName || SAMPLE.agency_name : SAMPLE[f]));

/** The owner's missed-call settings: greeting, text, ceilings. Whether anything is sent is Skills'. */
export function MissedCallSettingsForm({
  initial,
  canManage,
  agencyName,
}: {
  initial: { greeting: string; smsTemplate: string; textsPerAgentDay: number; textsPerAgencyDay: number };
  canManage: boolean;
  agencyName: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [v, setV] = useState(initial);
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV((p) => ({ ...p, [k]: value }));
  return (
    <form
      className={styles.steps}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveMissedCallSettingsAction(v);
          if (!r.ok) {
            toast({ title: 'Not saved', description: r.error, variant: 'error' });
            return;
          }
          toast({ title: 'Saved. It applies to the next missed call.', variant: 'success' });
          router.refresh();
        });
      }}
    >
      <fieldset disabled={!canManage || pending} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: '0.75rem' }}>
        <section className={styles.step}>
          <h2 className={styles.stepTitle}>What the caller hears</h2>
          <p className={styles.muted}>Played when a missed call is forwarded to us and a text follows. It replaces the agent’s voicemail. When no text follows (the skill is off, a private number, they replied STOP), the caller hears: “Sorry, Sarah can’t take your call right now. They’ll get back to you soon.”</p>
          <textarea className={styles.textarea} value={v.greeting} onChange={(e) => set('greeting', e.target.value)} maxLength={300} aria-label="Greeting" />
          <p className={styles.muted}>Read out in an Australian English voice.</p>
        </section>

        <section className={styles.step}>
          <h2 className={styles.stepTitle}>The text</h2>
          <p className={styles.muted}>Sent from the agent’s Twilio number straight away, only while “Missed call text” is on in Skills for the agency and that agent. It’s this approved message, never written by the AI.</p>
          <textarea className={styles.textarea} value={v.smsTemplate} onChange={(e) => set('smsTemplate', e.target.value)} maxLength={480} aria-label="Text message" />
          <p className={styles.muted}>Fields: {'{{first_name}}'} (or “there” for a new caller) · {'{{agent_first_name}}'} · {'{{agency_name}}'} · {v.smsTemplate.length}/480</p>
          <div className={styles.bubble} style={{ background: 'var(--surface-canvas)', border: '1px solid var(--border-default)' }}>{preview(v.smsTemplate, agencyName)}</div>
        </section>

        <section className={styles.step}>
          <h2 className={styles.stepTitle}>Limits</h2>
          <p className={styles.muted}>So a fault or a flood of calls can’t run up your Twilio bill. Always: one text per caller a day, and nobody who replied STOP.</p>
          <div className={styles.fields}>
            <label className={styles.field}>
              Texts per agent a day
              <input className={styles.input} type="number" min={1} max={500} value={v.textsPerAgentDay} onChange={(e) => set('textsPerAgentDay', Number(e.target.value))} />
            </label>
            <label className={styles.field}>
              Texts per agency a day
              <input className={styles.input} type="number" min={1} max={5000} value={v.textsPerAgencyDay} onChange={(e) => set('textsPerAgencyDay', Number(e.target.value))} />
            </label>
          </div>
        </section>
      </fieldset>
      {canManage ? (
        <div className={styles.row}>
          <button className={styles.btnPrimary} type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
          <span className={styles.muted}>Applies to the next missed call.</span>
        </div>
      ) : (
        <p className={styles.muted}>Only owners and admins can change these.</p>
      )}
    </form>
  );
}
