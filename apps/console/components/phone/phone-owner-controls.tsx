'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { connectTwilioAction, disconnectTwilioAction, getNumberAction, refreshKycAction, releaseNumberAction, setUpAiCallsAction } from '@/lib/phone-actions';
import styles from './phone.module.css';

/**
 * The owner's controls on Connectors → Phone & SMS (ADR 0070). Each button only asks; the server
 * decides with can() and says why when it refuses.
 */

function useAct() {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const act = (run: () => Promise<{ ok: true; status?: string } | { ok: false; error: string }>, done: (status?: string) => string, failTitle: string) =>
    start(async () => {
      const r = await run();
      if (!r.ok) {
        toast({ title: failTitle, description: r.error, variant: 'error' });
        return;
      }
      toast({ title: done(r.status), variant: 'success' });
      router.refresh();
    });
  return { pending, act };
}

export function ConnectTwilioForm() {
  const { pending, act } = useAct();
  const [accountSid, setAccountSid] = useState('');
  const [apiKeySid, setApiKeySid] = useState('');
  const [apiKeySecret, setApiKeySecret] = useState('');
  return (
    <form
      className={styles.steps}
      onSubmit={(e) => {
        e.preventDefault();
        act(
          () => connectTwilioAction({ accountSid, apiKeySid, apiKeySecret }),
          (status) => (status === 'approved' ? 'Twilio connected. Your business is approved.' : 'Twilio connected. Next: Twilio checks your business.'),
          'Not connected',
        );
      }}
    >
      <div className={styles.fields}>
        <label className={styles.field}>
          Account SID
          <input className={styles.input} value={accountSid} onChange={(e) => setAccountSid(e.target.value)} placeholder="AC…" autoComplete="off" spellCheck={false} />
        </label>
        <label className={styles.field}>
          API key SID
          <input className={styles.input} value={apiKeySid} onChange={(e) => setApiKeySid(e.target.value)} placeholder="SK…" autoComplete="off" spellCheck={false} />
        </label>
        <label className={styles.field}>
          API key secret
          <input className={styles.input} type="password" value={apiKeySecret} onChange={(e) => setApiKeySecret(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
        </label>
      </div>
      <div className={styles.row}>
        <button className={styles.btnPrimary} type="submit" disabled={pending}>{pending ? 'Checking with Twilio…' : 'Connect'}</button>
        <span className={styles.muted}>Use an API key, not your Twilio password. The secret is stored encrypted, and you can delete the key in Twilio at any time.</span>
      </div>
    </form>
  );
}

export function DisconnectTwilio() {
  const { pending, act } = useAct();
  return (
    <button
      type="button"
      className={styles.btnLink}
      disabled={pending}
      style={{ marginLeft: 'auto' }}
      onClick={() => {
        if (!window.confirm('Disconnect Twilio? Your agents’ numbers stop working here. The numbers stay on your Twilio account until you release them there.')) return;
        act(() => disconnectTwilioAction(), () => 'Twilio disconnected', 'Not disconnected');
      }}
    >
      Disconnect
    </button>
  );
}

export function KycCheckButton() {
  const { pending, act } = useAct();
  return (
    <button type="button" className={styles.btn} disabled={pending} onClick={() => act(() => refreshKycAction(), (s) => (s === 'approved' ? 'Approved by Twilio' : 'Checked: not approved yet'), 'Could not check')}>
      {pending ? 'Checking…' : 'Check now'}
    </button>
  );
}

export function SetUpAiCallsButton({ again }: { again: boolean }) {
  const { pending, act } = useAct();
  return (
    <button type="button" className={again ? styles.btn : styles.btnPrimary} disabled={pending} onClick={() => act(() => setUpAiCallsAction(), (s) => `AI calls: ${s ?? 'ready'}`, 'Not set up')}>
      {pending ? 'Setting up…' : again ? 'Set up the new numbers' : 'Set up AI calls'}
    </button>
  );
}

export function GetNumberButton({ agentUserId, name }: { agentUserId: string; name: string }) {
  const { pending, act } = useAct();
  return (
    <button
      type="button"
      className={styles.btn}
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Get ${name} an Australian mobile number on your Twilio account? Twilio charges for it monthly.`)) return;
        act(() => getNumberAction(agentUserId), (display) => `${name}’s number: ${display ?? 'ready'}`, 'No number');
      }}
    >
      {pending ? 'Getting a number…' : 'Get a number'}
    </button>
  );
}

export function ReleaseNumberButton({ numberId, display }: { numberId: string; display: string }) {
  const { pending, act } = useAct();
  return (
    <button
      type="button"
      className={styles.btnLink}
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Give ${display} back to Twilio? Calls and texts to it stop. Its texts stay in the history.`)) return;
        act(() => releaseNumberAction(numberId), () => `${display} released`, 'Not released');
      }}
    >
      Release
    </button>
  );
}
