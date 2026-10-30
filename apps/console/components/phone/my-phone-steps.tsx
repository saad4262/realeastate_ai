'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { forwardingTestStatusAction, refreshCallerIdAction, startCallerIdAction, startForwardingTestAction } from '@/lib/phone-actions';
import styles from './phone.module.css';

/**
 * One agent's phone side (ADR 0070): verify their mobile as caller ID, forward the calls they miss to
 * their Twilio number, and prove it with a test call. The codes to dial come from the server (core's
 * rule); this only walks the steps and polls while Twilio calls.
 */

export type MyPhoneStepsView = {
  number: { display: string; callerId: string | null; callerIdStatus: 'none' | 'pending' | 'verified'; forwardingTestedAt: Date | null; live: boolean } | null;
  profileMobile: string | null;
  lastTest: { status: 'calling' | 'passed' | 'failed'; at: Date } | null;
};

const CARRIERS = [
  ['telstra', 'Telstra'],
  ['optus', 'Optus'],
  ['vodafone', 'Vodafone'],
  ['other', 'Other / not sure'],
] as const;

/** Polls `check` every 4 s until it says stop, for at most `ms`. */
function usePoll() {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);
  return (check: () => Promise<boolean>, ms: number, onTimeout: () => void) => {
    if (timer.current) clearInterval(timer.current);
    const until = Date.now() + ms;
    timer.current = setInterval(async () => {
      if (Date.now() > until) {
        clearInterval(timer.current!);
        onTimeout();
        return;
      }
      if (await check()) clearInterval(timer.current!);
    }, 4000);
  };
}

export function MyPhoneSteps({ view, codes }: { view: MyPhoneStepsView; codes?: Record<number, { on: string; off: string }> }) {
  const router = useRouter();
  const { toast } = useToast();
  const poll = usePoll();
  const [pending, start] = useTransition();
  const n = view.number;
  const verified = n?.callerIdStatus === 'verified';
  const [mobile, setMobile] = useState(n?.callerId ?? view.profileMobile ?? '');
  const [code, setCode] = useState<string | null>(null);
  const [waitingCode, setWaitingCode] = useState(false);
  const [dialled, setDialled] = useState(false);
  const [carrier, setCarrier] = useState<string>('telstra');
  const [seconds, setSeconds] = useState(20);
  const [testing, setTesting] = useState(view.lastTest?.status === 'calling');
  const [testFailed, setTestFailed] = useState(view.lastTest?.status === 'failed');
  const [again, setAgain] = useState(false);

  if (!n) {
    return <p className={styles.muted}>You have no Twilio number yet. An owner or admin gets you one in Connectors → Phone &amp; SMS.</p>;
  }

  const step = !verified ? 1 : n.live && !again ? 4 : dialled || again ? 3 : 2;
  const dial = codes?.[seconds] ?? codes?.[20];

  const verify = () =>
    start(async () => {
      const r = await startCallerIdAction(mobile);
      if (!r.ok) {
        toast({ title: 'Not started', description: r.error, variant: 'error' });
        return;
      }
      if (r.verified) {
        toast({ title: 'Your mobile is verified', variant: 'success' });
        router.refresh();
        return;
      }
      setCode(r.code ?? null);
      setWaitingCode(true);
      poll(
        async () => {
          const s = await refreshCallerIdAction();
          if (s.ok && s.status === 'verified') {
            setWaitingCode(false);
            toast({ title: 'Your mobile is verified', variant: 'success' });
            router.refresh();
            return true;
          }
          return false;
        },
        3 * 60 * 1000,
        () => {
          setWaitingCode(false);
          toast({ title: 'Not verified yet', description: 'Twilio didn’t hear the code. Try again.', variant: 'error' });
        },
      );
    });

  const test = () =>
    start(async () => {
      setTestFailed(false);
      const r = await startForwardingTestAction();
      if (!r.ok) {
        toast({ title: 'No test call', description: r.error, variant: 'error' });
        return;
      }
      if (r.status === 'passed') {
        setAgain(false);
        toast({ title: 'Forwarding works', variant: 'success' });
        router.refresh();
        return;
      }
      setTesting(true);
      poll(
        async () => {
          const s = await forwardingTestStatusAction();
          if (s.ok && s.status === 'passed') {
            setTesting(false);
            setAgain(false);
            toast({ title: 'Forwarding works', variant: 'success' });
            router.refresh();
            return true;
          }
          if (s.ok && s.status === 'failed') {
            setTesting(false);
            setTestFailed(true);
            return true;
          }
          return false;
        },
        4 * 60 * 1000,
        () => {
          setTesting(false);
          setTestFailed(true);
        },
      );
    });

  return (
    <div className={styles.steps}>
      <p className={styles.muted}>
        Your Twilio number: <b className={styles.mono}>{n.display}</b>
      </p>

      {step === 1 ? (
        <section className={styles.step}>
          <div className={styles.stepHead}><span className={styles.stepNum}>1</span><h3 className={styles.stepTitle}>Verify your mobile</h3></div>
          <p style={{ margin: 0 }}>When the AI calls someone back for you, they’ll see your own number, not a strange one.</p>
          <div className={styles.row}>
            <label className={styles.field}>
              Your mobile
              <input className={styles.input} value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="04xx xxx xxx" inputMode="tel" />
            </label>
            <button type="button" className={styles.btnPrimary} disabled={pending || waitingCode || !mobile.trim()} onClick={verify} style={{ alignSelf: 'end' }}>
              Call me with a code
            </button>
          </div>
          {code ? (
            <div className={styles.steps}>
              <p style={{ margin: 0 }}>Twilio is calling you now. Answer, and type this code on your phone’s keypad:</p>
              <div className={styles.code} aria-label={`Code ${code.split('').join(' ')}`}>
                {code.split('').map((d, i) => <span key={i}>{d}</span>)}
              </div>
              {waitingCode ? <p className={styles.muted}>Waiting for you to enter it…</p> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {step === 2 ? (
        <section className={styles.step}>
          <div className={styles.stepHead}><span className={`${styles.stepNum} ${styles.stepDone}`}>✓</span><h3 className={styles.stepTitle}>Mobile verified · {n.callerId}</h3></div>
          <div className={styles.stepHead}><span className={styles.stepNum}>2</span><h3 className={styles.stepTitle}>Forward the calls you miss</h3></div>
          <div className={styles.row}>
            <label className={styles.field}>
              Your mobile network
              <select className={styles.input} value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                {CARRIERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              Ring before forwarding
              <select className={styles.input} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
                {[15, 20, 30].map((s) => <option key={s} value={s}>{s} seconds</option>)}
              </select>
            </label>
          </div>
          <p style={{ margin: 0 }}>On your mobile, open the phone keypad, type this and press call:</p>
          <div className={styles.dial}>
            <code>{dial?.on ?? '—'}</code>
            <button type="button" className={styles.btn} onClick={() => dial && navigator.clipboard?.writeText(dial.on)}>Copy</button>
            <span className={styles.muted}>Your phone shows “Call forwarding activated”.</span>
          </div>
          <p className={`${styles.note} ${styles.noteWarn}`}>
            <span className={styles.glyph} aria-hidden>voicemail</span>
            <span>
              <b>This replaces your voicemail.</b> A caller you miss hears a short message instead. To turn it off later, dial <b>{dial?.off ?? '##61#'}</b>. Your network may charge a forwarded call like a normal call; most unlimited plans include it.
            </span>
          </p>
          <div className={styles.row}><button type="button" className={styles.btnPrimary} onClick={() => setDialled(true)}>I’ve dialled it</button></div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className={styles.step}>
          <div className={styles.stepHead}><span className={styles.stepNum}>3</span><h3 className={styles.stepTitle}>Test call</h3></div>
          <p style={{ margin: 0 }}>We’ll call your mobile from your Twilio number. <b>Don’t answer.</b> Let it ring out, and we’ll check the call comes back to us.</p>
          <div className={styles.row}>
            <button type="button" className={styles.btnPrimary} disabled={pending || testing} onClick={test}>{testing ? 'Calling your mobile…' : 'Start test call'}</button>
            {!n.live ? <button type="button" className={styles.btnLink} onClick={() => setDialled(false)}>Show the code again</button> : null}
          </div>
          {testing ? <p className={styles.muted}>Ringing… don’t answer. It can take up to a minute.</p> : null}
          {testFailed ? (
            <p className={`${styles.note} ${styles.noteBad}`}>
              <span className={styles.glyph} aria-hidden>error</span>
              <span>The call didn’t come back to us. Check that forwarding is on (dial the code again), that you didn’t answer, then test again.</span>
            </p>
          ) : null}
        </section>
      ) : null}

      {step === 4 ? (
        <section className={styles.step}>
          <p className={`${styles.note} ${styles.noteOk}`}>
            <span className={styles.glyph} aria-hidden>check_circle</span>
            <span><b>Your phone is set up.</b> Verified {n.callerId} · forwarding tested {n.forwardingTestedAt?.toLocaleString('en-AU')}. You’ll be told about the calls you miss, and you can text people from your number in Inbox → Texts.</span>
          </p>
          <p className={`${styles.note} ${styles.noteWarn}`}>
            <span className={styles.glyph} aria-hidden>toggle_off</span>
            <span>Nobody gets a text or a call from you automatically. That comes as skills you switch on in Skills.</span>
          </p>
          <div className={styles.row}>
            <button type="button" className={styles.btn} onClick={() => setAgain(true)}>Test again</button>
            <span className={styles.muted}>Changed phones or network? Dial the code and test again.</span>
          </div>
        </section>
      ) : null}
    </div>
  );
}
