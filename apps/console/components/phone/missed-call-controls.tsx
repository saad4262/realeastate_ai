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

type Day = [number, number] | null;
type Hours = { weekdays: Day; saturday: Day; sunday: Day };
const DAYS: [keyof Hours, string, [number, number]][] = [
  ['weekdays', 'Mon–Fri', [8, 20]],
  ['saturday', 'Saturday', [9, 17]],
  ['sunday', 'Sunday', [10, 16]],
];
const hourLabel = (h: number) => (h === 0 || h === 24 ? '12 am' : h === 12 ? '12 pm' : h < 12 ? `${h} am` : `${h - 12} pm`);

const SAMPLE = { first_name: 'John', agent_first_name: 'Sarah', agency_name: 'your agency' };
const preview = (t: string, agencyName: string) =>
  t.replace(/\{\{\s*(first_name|agent_first_name|agency_name)\s*\}\}/g, (_, f: keyof typeof SAMPLE) => (f === 'agency_name' ? agencyName || SAMPLE.agency_name : SAMPLE[f]));

/** The owner's missed-call settings: greeting, text, ceilings. Whether anything is sent is Skills'. */
export function MissedCallSettingsForm({
  initial,
  canManage,
  agencyName,
}: {
  initial: {
    greeting: string;
    smsTemplate: string;
    textsPerAgentDay: number;
    textsPerAgencyDay: number;
    aiCallAfterMinutes: number;
    callingHours: Hours;
    aiCallsPerAgentDay: number;
    aiCallsPerAgencyDay: number;
  };
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
          <h2 className={styles.stepTitle}>How the AI calls back</h2>
          <p className={styles.muted}>Only while “AI calls back” is on in Skills for the agency and that agent. It calls from the agent’s number, says it is an AI assistant and that the call may be recorded, asks what they need and offers a call back from the agent. It never gives prices, valuations or promises, and books nothing. Once per caller a day; never anyone who replied STOP.</p>
          <div className={styles.fields}>
            <label className={styles.field}>
              Call back after the missed call
              <select className={styles.input} value={v.aiCallAfterMinutes} onChange={(e) => set('aiCallAfterMinutes', Number(e.target.value))}>
                {[1, 2, 5, 10].map((m) => <option key={m} value={m}>{m} minute{m > 1 ? 's' : ''}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              AI calls per agent a day
              <input className={styles.input} type="number" min={1} max={200} value={v.aiCallsPerAgentDay} onChange={(e) => set('aiCallsPerAgentDay', Number(e.target.value))} />
            </label>
            <label className={styles.field}>
              AI calls per agency a day
              <input className={styles.input} type="number" min={1} max={2000} value={v.aiCallsPerAgencyDay} onChange={(e) => set('aiCallsPerAgencyDay', Number(e.target.value))} />
            </label>
          </div>
          <b style={{ fontSize: '0.8125rem' }}>Calling hours (the agency’s time)</b>
          <p className={styles.muted}>A call missed outside these hours is called back when they next open: a 10 pm missed call at 8 am.</p>
          {DAYS.map(([key, label, fallback]) => {
            const day = v.callingHours[key];
            const setDay = (d: Day) => set('callingHours', { ...v.callingHours, [key]: d });
            return (
              <div key={key} className={styles.row}>
                <label className={styles.row} style={{ minWidth: '9rem' }}>
                  <input type="checkbox" checked={day !== null} onChange={(e) => setDay(e.target.checked ? fallback : null)} />
                  {label}
                </label>
                {day ? (
                  <>
                    <select className={styles.input} aria-label={`${label} from`} value={day[0]} onChange={(e) => setDay([Number(e.target.value), Math.max(day[1], Number(e.target.value) + 1)])}>
                      {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                    </select>
                    <span className={styles.muted}>to</span>
                    <select className={styles.input} aria-label={`${label} to`} value={day[1]} onChange={(e) => setDay([day[0], Number(e.target.value)])}>
                      {Array.from({ length: 24 }, (_, i) => i + 1).filter((h) => h > day[0]).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                    </select>
                  </>
                ) : (
                  <span className={styles.muted}>No AI calls</span>
                )}
              </div>
            );
          })}
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
