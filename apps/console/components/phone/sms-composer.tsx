'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { sendSmsAction } from '@/lib/phone-actions';
import styles from './phone.module.css';

/** The reply box under a text conversation (ADR 0070). Sent only when the agent presses Send. */
export function SmsComposer({ to }: { to: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [body, setBody] = useState('');
  const [pending, start] = useTransition();
  const send = () =>
    start(async () => {
      const r = await sendSmsAction(to, body);
      if (!r.ok) {
        toast({ title: 'Not sent', description: r.error, variant: 'error' });
        return;
      }
      setBody('');
      router.refresh();
    });
  return (
    <form
      className={styles.steps}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea className={styles.textarea} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a text…" maxLength={1600} aria-label="Text message" />
      <div className={styles.row}>
        <button className={styles.btnPrimary} type="submit" disabled={pending || !body.trim()}>{pending ? 'Sending…' : 'Send'}</button>
        <span className={styles.muted}>{body.length}/1600 · long texts go as several parts, each charged by Twilio.</span>
      </div>
    </form>
  );
}

/** A first text to someone (a mobile number). Afterwards it is an ordinary conversation. */
export function NewTextForm({ base }: { base: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [pending, start] = useTransition();
  return (
    <form
      className={styles.steps}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await sendSmsAction(to, body);
          if (!r.ok) {
            toast({ title: 'Not sent', description: r.error, variant: 'error' });
            return;
          }
          toast({ title: 'Text sent', variant: 'success' });
          router.push(base);
          router.refresh();
        });
      }}
    >
      <b>New text</b>
      <label className={styles.field}>
        To (an Australian mobile)
        <input className={styles.input} value={to} onChange={(e) => setTo(e.target.value)} placeholder="04xx xxx xxx" inputMode="tel" />
      </label>
      <textarea className={styles.textarea} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a text…" maxLength={1600} aria-label="Text message" />
      <div className={styles.row}>
        <button className={styles.btnPrimary} type="submit" disabled={pending || !to.trim() || !body.trim()}>{pending ? 'Sending…' : 'Send'}</button>
        <span className={styles.muted}>From your own Twilio number. Nobody who replied STOP can be texted.</span>
      </div>
    </form>
  );
}
