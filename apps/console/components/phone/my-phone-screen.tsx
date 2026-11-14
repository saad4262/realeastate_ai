import Link from 'next/link';
import { getMyPhone, listMyTwilioNumbers, phoneDepsFromEnv, PhoneError, voiceFromEnv, type KycStatus, type MyPhoneView, type OwnTwilioNumber } from '@repo/core/phone';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { BringMyNumberButton, BuyMyNumberButton, DisconnectMyTwilio, MyKycCheckButton, SetUpMyAiCallsButton, StopUsingMyNumberButton } from './my-twilio-controls';
import { MyPhoneSteps } from './my-phone-steps';
import { ConnectTwilioForm } from './phone-owner-controls';
import { dialCodes, keysOrNull } from './phone-setup-screen';
import styles from './phone.module.css';

/**
 * Connectors → My phone (ADR 0070): an agent's own phone side. Their number is the agency's to give,
 * or (ADR 0087) one on a Twilio account of their own, which only they connect and use.
 */

const KYC_WORDS: Record<KycStatus, { label: string; cls: string }> = {
  unknown: { label: 'Not checked yet', cls: '' },
  none: { label: 'Not submitted', cls: styles.warn! },
  pending: { label: 'Twilio is reviewing', cls: styles.warn! },
  needs_fix: { label: 'Twilio needs a fix', cls: styles.bad! },
  approved: { label: 'Approved', cls: styles.ok! },
};

export async function MyPhoneScreen() {
  const session = await requireConsoleAccess('agent');
  const db = getConsoleDb();
  let view: MyPhoneView;
  try {
    view = await getMyPhone(db, session.actor, { keys: keysOrNull() });
  } catch (err) {
    return <p role="alert">{err instanceof PhoneError ? err.message : 'Could not load your phone.'}</p>;
  }
  // The numbers already on their own Twilio, asked of Twilio only while they have none here.
  let offered: OwnTwilioNumber[] = [];
  let offeredError: string | null = null;
  if (view.own?.status === 'connected' && !view.number) {
    try {
      offered = await listMyTwilioNumbers(db, session.actor, phoneDepsFromEnv());
    } catch (err) {
      offeredError = err instanceof PhoneError ? err.message : 'Could not list the numbers on your Twilio.';
    }
  }
  const aiOn = Boolean(voiceFromEnv().voice);

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <Link href="/my-integrations" className={styles.btnLink}>← Connectors</Link>
        <h1 className={contactStyles.title}>My phone</h1>
        <p className={contactStyles.sub}>
          Keep using your phone as normal. The calls you miss come here, and you can text people from your own number — one of the
          agency’s, or one on a Twilio account of your own.
        </p>
      </div>
      <div className={styles.steps}>
        {view.number ? (
          <section className={styles.step}>
            {view.number.onOwnTwilio ? (
              <div className={styles.row}>
                <span className={`${styles.pill} ${styles.ok}`}>On your own Twilio</span>
                <span className={styles.muted}>Twilio bills you for it. The agency can read its texts, and keeps them if you leave.</span>
                <StopUsingMyNumberButton display={view.number.display} />
              </div>
            ) : null}
            <MyPhoneSteps view={view} codes={dialCodes(view.number.e164)} />
            {view.number.onOwnTwilio && aiOn ? (
              <div className={styles.row}>
                <SetUpMyAiCallsButton />
                <span className={styles.muted}>Lets the AI call your missed callers back from this number, while “AI calls back” is on in Skills.</span>
              </div>
            ) : null}
          </section>
        ) : (
          <section className={styles.step} aria-labelledby="agency-number">
            <div className={styles.stepHead}>
              <h2 id="agency-number" className={styles.stepTitle}>One of the agency’s numbers</h2>
            </div>
            <p className={styles.note}>
              <span className={styles.glyph} aria-hidden>info</span>
              <span>
                {!view.connected
                  ? 'Your agency hasn’t connected its Twilio yet. An owner or admin does that in Connectors → Phone & SMS.'
                  : view.kycStatus === 'approved'
                    ? 'Ask an owner or admin to get you one in Connectors → Phone & SMS.'
                    : 'Twilio is still checking your agency’s business. Once it approves, an owner or admin can get you a number.'}
              </span>
            </p>
          </section>
        )}

        {view.canConnectOwn ? <OwnTwilio view={view} offered={offered} offeredError={offeredError} /> : null}
      </div>
    </div>
  );
}

function OwnTwilio({ view, offered, offeredError }: { view: MyPhoneView; offered: OwnTwilioNumber[]; offeredError: string | null }) {
  const own = view.own;
  const approved = own?.kycStatus === 'approved';
  return (
    <section className={styles.step} aria-labelledby="own-twilio">
      <div className={styles.stepHead}>
        <h2 id="own-twilio" className={styles.stepTitle}>{view.number ? 'Your own Twilio' : 'Or: your own Twilio'}</h2>
        <span className={styles.stepRight}>
          {own ? <span className={`${styles.pill} ${own.status === 'error' ? styles.bad : styles.ok}`}>{own.status === 'error' ? 'Key refused' : 'Connected'}</span> : <span className={styles.pill}>Not connected</span>}
        </span>
      </div>
      {!own ? (
        <>
          <p className={styles.muted}>
            Bring a Twilio account of your own: the number is yours, Twilio bills you, and it goes with you if you change agency. The agency
            can still read its texts, and keeps the ones from your time here. Only you can use it.
          </p>
          <div className={styles.note}>
            <span className={styles.glyph} aria-hidden>checklist</span>
            <div>
              <b>Twilio asks for (once, in Twilio):</b>
              <ul className={styles.list}>
                <li>A paid account (a free trial can’t verify you or text your customers)</li>
                <li>Your ID and an Australian address, or your business’s ABN, for an Australian mobile number</li>
              </ul>
            </div>
          </div>
          <div className={styles.row}>
            <a className={styles.btn} href="https://www.twilio.com/try-twilio" target="_blank" rel="noreferrer">Open Twilio sign-up ↗</a>
            <span className={styles.muted}>In Twilio: Account → API keys → Create API key (Standard). Paste its SID and secret here with your Account SID.</span>
          </div>
          <ConnectTwilioForm own />
        </>
      ) : (
        <>
          <div className={styles.row}>
            <span>Twilio account <b>{own.friendlyName ?? own.accountSidHint}</b></span>
            <span className={styles.muted}>· connected {own.connectedAt.toLocaleDateString('en-AU')}</span>
            <DisconnectMyTwilio />
          </div>
          {own.status === 'error' ? (
            <>
              <p className={`${styles.note} ${styles.noteBad}`}>{own.error ?? 'Twilio refused the saved key.'} Connect it again below.</p>
              <ConnectTwilioForm own />
            </>
          ) : view.number ? null : (
            <>
              <div className={styles.row}>
                <span>Twilio’s check of your documents</span>
                <span className={`${styles.pill} ${KYC_WORDS[own.kycStatus].cls}`}>{KYC_WORDS[own.kycStatus].label}</span>
                {!approved ? <MyKycCheckButton /> : null}
              </div>
              {!approved ? (
                <p className={`${styles.note} ${own.kycStatus === 'needs_fix' ? styles.noteBad : styles.noteWarn}`}>
                  <span className={styles.glyph} aria-hidden>{own.kycStatus === 'needs_fix' ? 'error' : 'hourglass_top'}</span>
                  <span>
                    {own.kycNote ??
                      (own.kycStatus === 'pending'
                        ? 'Twilio is reviewing your documents. It usually takes a few business days. We check every hour.'
                        : 'Submit your documents in Twilio (Regulatory Compliance → Australia, mobile numbers), then check again here.')}
                  </span>
                </p>
              ) : null}
              {offered.some((n) => !n.unavailable) ? (
                <div className={styles.row}>
                  <span className={styles.muted}>Already on your Twilio:</span>
                  {offered
                    .filter((n) => !n.unavailable)
                    .map((n) => (
                      <BringMyNumberButton key={n.sid} sid={n.sid} display={n.display} />
                    ))}
                </div>
              ) : null}
              {offered
                .filter((n) => n.unavailable)
                .map((n) => (
                  <p key={n.sid} className={styles.muted}>
                    {n.display} can’t be used here yet: {n.unavailable}
                  </p>
                ))}
              {offeredError ? <p className={`${styles.note} ${styles.noteBad}`}>{offeredError}</p> : null}
              {approved ? (
                <div className={styles.row}>
                  <BuyMyNumberButton />
                  <span className={styles.muted}>A new Australian mobile number on your Twilio. Twilio charges you for it monthly.</span>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  );
}
