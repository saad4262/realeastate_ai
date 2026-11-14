'use client';

import {
  buyMyNumberAction,
  disconnectMyTwilioAction,
  refreshMyKycAction,
  setUpMyAiCallsAction,
  stopUsingMyNumberAction,
  bringMyTwilioNumberAction,
} from '@/lib/phone-actions';
import { useAct } from './phone-owner-controls';
import styles from './phone.module.css';

/**
 * An agent's controls for their own Twilio on My phone (ADR 0087). Each button only asks; the server
 * decides with can() — `phone:own`, the person themselves — and says why when it refuses.
 */

export function DisconnectMyTwilio() {
  const { pending, act } = useAct();
  return (
    <button
      type="button"
      className={styles.btnLink}
      disabled={pending}
      style={{ marginLeft: 'auto' }}
      onClick={() => {
        if (!window.confirm('Disconnect your Twilio? A number on it stops working here. It stays yours in Twilio.')) return;
        act(() => disconnectMyTwilioAction(), (note) => (note ? `Your Twilio is disconnected. ${note}` : 'Your Twilio is disconnected'), 'Not disconnected');
      }}
    >
      Disconnect
    </button>
  );
}

export function MyKycCheckButton() {
  const { pending, act } = useAct();
  return (
    <button type="button" className={styles.btn} disabled={pending} onClick={() => act(() => refreshMyKycAction(), (s) => (s === 'approved' ? 'Approved by Twilio' : 'Checked: not approved yet'), 'Could not check')}>
      {pending ? 'Checking…' : 'Check now'}
    </button>
  );
}

export function BuyMyNumberButton() {
  const { pending, act } = useAct();
  return (
    <button
      type="button"
      className={styles.btnPrimary}
      disabled={pending}
      onClick={() => {
        if (!window.confirm('Get an Australian mobile number on your own Twilio? Twilio charges you for it monthly.')) return;
        act(() => buyMyNumberAction(), (display) => `Your number: ${display ?? 'ready'}`, 'No number');
      }}
    >
      {pending ? 'Getting a number…' : 'Get a new number'}
    </button>
  );
}

export function BringMyNumberButton({ sid, display }: { sid: string; display: string }) {
  const { pending, act } = useAct();
  return (
    <button
      type="button"
      className={styles.btn}
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Use ${display} here? Its texts and calls will come to this agency’s console.`)) return;
        act(() => bringMyTwilioNumberAction(sid), (d) => `Now using ${d ?? display}`, 'Not used');
      }}
    >
      {pending ? 'Pointing it here…' : `Use ${display}`}
    </button>
  );
}

export function StopUsingMyNumberButton({ display }: { display: string }) {
  const { pending, act } = useAct();
  return (
    <button
      type="button"
      className={styles.btnLink}
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Stop using ${display} here? It stays yours in Twilio. Its texts so far stay with the agency.`)) return;
        act(() => stopUsingMyNumberAction(), () => `${display} is no longer used here`, 'Not changed');
      }}
    >
      Stop using it here
    </button>
  );
}

export function SetUpMyAiCallsButton() {
  const { pending, act } = useAct();
  return (
    <button type="button" className={styles.btn} disabled={pending} onClick={() => act(() => setUpMyAiCallsAction(), (s) => s ?? 'Ready', 'Not set up')}>
      {pending ? 'Setting up…' : 'Set up AI calls on my Twilio'}
    </button>
  );
}
