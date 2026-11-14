'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { connectMyTwilioAction, connectTwilioAction, disconnectTwilioAction, getNumberAction, refreshKycAction, releaseNumberAction, setUpAiCallsAction, startManagedPhoneAction } from '@/lib/phone-actions';
import styles from './phone.module.css';

/**
 * The owner's controls on Connectors → Phone & SMS (ADR 0070). Each button only asks; the server
 * decides with can() and says why when it refuses.
 */

export function useAct() {
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

/** `own`: the person's own Twilio on My phone (ADR 0087), not the agency's. */
export function ConnectTwilioForm({ own = false }: { own?: boolean }) {
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
          () => (own ? connectMyTwilioAction : connectTwilioAction)({ accountSid, apiKeySid, apiKeySecret }),
          (status) =>
            status === 'approved'
              ? `Twilio connected. ${own ? 'Your documents are' : 'Your business is'} approved.`
              : `Twilio connected. Next: Twilio checks ${own ? 'your documents' : 'your business'}.`,
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

/** ADR 0090: "set it up for us" — a managed subaccount, nothing to paste. */
export function StartManagedPhoneButton({ testMode }: { testMode: boolean }) {
  const { pending, act } = useAct();
  return (
    <button
      type="button"
      className={styles.btnPrimary}
      disabled={pending}
      onClick={() =>
        act(
          () => startManagedPhoneAction(),
          (status) => (status === 'approved' ? (testMode ? 'Phone numbers are ready (test mode, US numbers)' : 'Phone numbers are ready') : 'Set up. Next: your business details'),
          'Not set up',
        )
      }
    >
      {pending ? 'Setting up…' : 'Set it up for me'}
    </button>
  );
}

export function DisconnectTwilio({ managed = false }: { managed?: boolean }) {
  const { pending, act } = useAct();
  return (
    <button
      type="button"
      className={styles.btnLink}
      disabled={pending}
      style={{ marginLeft: 'auto' }}
      onClick={() => {
        const ask = managed
          ? 'Turn off phone numbers? Every agent’s number is given up for good and cannot be got back. Their texts so far stay in the history.'
          : 'Disconnect Twilio? Your agents’ numbers stop working here. The numbers stay on your Twilio account until you release them there.';
        if (!window.confirm(ask)) return;
        act(() => disconnectTwilioAction(), (note) => (note ? `Twilio disconnected. ${note}` : managed ? 'Phone numbers turned off' : 'Twilio disconnected'), 'Not disconnected');
      }}
    >
      {managed ? 'Turn off' : 'Disconnect'}
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

export function GetNumberButton({ agentUserId, name, managed = false, usTest = false }: { agentUserId: string; name: string; managed?: boolean; usTest?: boolean }) {
  const { pending, act } = useAct();
  return (
    <button
      type="button"
      className={styles.btn}
      disabled={pending}
      onClick={() => {
        const ask = usTest
          ? `Get ${name} a US (+1) test number? Test mode: for trying things out, not for customers.`
          : managed
            ? `Get ${name} an Australian mobile number? It is charged monthly through your plan.`
            : `Get ${name} an Australian mobile number on your Twilio account? Twilio charges for it monthly.`;
        if (!window.confirm(ask)) return;
        act(() => getNumberAction(agentUserId), (display) => `${name}’s number: ${display ?? 'ready'}`, 'No number');
      }}
    >
      {pending ? 'Getting a number…' : 'Get a number'}
    </button>
  );
}

export function ReleaseNumberButton({ numberId, display, hadBefore = false }: { numberId: string; display: string; hadBefore?: boolean }) {
  const { pending, act } = useAct();
  return (
    <button
      type="button"
      className={styles.btnLink}
      disabled={pending}
      onClick={() => {
        const ask = hadBefore
          ? `Stop using ${display} here? It stays on your Twilio, set back to what it was before. Its texts stay in the history.`
          : `Give ${display} back to Twilio? Calls and texts to it stop. Its texts stay in the history.`;
        if (!window.confirm(ask)) return;
        act(() => releaseNumberAction(numberId), () => `${display} released`, 'Not released');
      }}
    >
      Release
    </button>
  );
}
