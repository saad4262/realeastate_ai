import Link from 'next/link';
import { forwardingCodes, FORWARD_SECONDS, getMyPhone, getPhoneSetup, PhoneError, type KycStatus, type PhoneSetupView } from '@repo/core/phone';
import { tokenKeysFromEnv } from '@repo/core/integrations';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { ConnectTwilioForm, DisconnectTwilio, GetNumberButton, KycCheckButton, ReleaseNumberButton } from './phone-owner-controls';
import { MyPhoneSteps } from './my-phone-steps';
import styles from './phone.module.css';

/**
 * Connectors → Phone & SMS (ADR 0070), the agency side: connect the agency's own Twilio, see Twilio's
 * business check, get each agent a number. An owner or admin who has a number of their own sets up
 * its phone side below. Every figure is from core; every button asks can() again on the server.
 */

/** The codes to dial for each ring time, from core's rule (the client never computes them). */
export function dialCodes(twilioE164: string): Record<number, { on: string; off: string }> {
  return Object.fromEntries(FORWARD_SECONDS.map((s) => [s, forwardingCodes('other', twilioE164, s)]));
}

export function keysOrNull() {
  try {
    return tokenKeysFromEnv();
  } catch {
    return null;
  }
}

const KYC_WORDS: Record<KycStatus, { label: string; cls: string }> = {
  unknown: { label: 'Not checked yet', cls: '' },
  none: { label: 'Not submitted', cls: styles.warn! },
  pending: { label: 'Twilio is reviewing', cls: styles.warn! },
  needs_fix: { label: 'Twilio needs a fix', cls: styles.bad! },
  approved: { label: 'Approved', cls: styles.ok! },
};

export async function PhoneSetupScreen() {
  const session = await requireConsoleAccess('agency');
  const keys = keysOrNull();
  let view: PhoneSetupView;
  try {
    view = await getPhoneSetup(getConsoleDb(), session.actor, { keys });
  } catch (err) {
    return <p role="alert">{err instanceof PhoneError ? err.message : 'Could not load the phone setup.'}</p>;
  }
  const me = await getMyPhone(getConsoleDb(), session.actor, { keys });
  const a = view.account;
  const approved = a?.kycStatus === 'approved';
  const live = view.agents.filter((g) => g.number?.live).length;

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <Link href="/settings/integrations" className={styles.btnLink}>← Connectors</Link>
        <h1 className={contactStyles.title}>Phone &amp; SMS</h1>
        <p className={contactStyles.sub}>
          Your agents keep their own phones. Only the calls they miss come here, and they can text people from their own number.
          The agency uses its own Twilio account, and Twilio bills the agency directly.
        </p>
      </div>

      {!view.configured ? (
        <p className={`${styles.note} ${styles.noteWarn}`}>
          <span className={styles.glyph} aria-hidden>construction</span>
          <span>Phone &amp; SMS isn’t switched on for this server yet (INTEGRATION_TOKEN_KEY is missing). Nothing here can be saved until it is.</span>
        </p>
      ) : null}

      <div className={styles.steps}>
        {/* 1. Connect */}
        <section className={styles.step} aria-labelledby="s1">
          <div className={styles.stepHead}>
            <span className={`${styles.stepNum} ${a ? styles.stepDone : ''}`}>{a ? '✓' : '1'}</span>
            <h2 id="s1" className={styles.stepTitle}>Connect your Twilio account</h2>
            <span className={styles.stepRight}>
              {a ? <span className={`${styles.pill} ${a.status === 'error' ? styles.bad : styles.ok}`}>{a.status === 'error' ? 'Key refused' : 'Connected'}</span> : <span className={styles.pill}>Not connected</span>}
            </span>
          </div>
          {a ? (
            <>
              <div className={styles.row}>
                <span>Twilio account <b>{a.friendlyName ?? a.accountSidHint}</b></span>
                <span className={styles.muted}>· {a.accountSidHint} · connected {a.connectedAt.toLocaleDateString('en-AU')}</span>
                {view.canManage ? <DisconnectTwilio /> : null}
              </div>
              {a.status === 'error' ? <p className={`${styles.note} ${styles.noteBad}`}>{a.error ?? 'Twilio refused the saved key.'} Connect it again below.</p> : null}
              {view.canManage && a.status === 'error' ? <ConnectTwilioForm /> : null}
            </>
          ) : view.canManage ? (
            <>
              <div className={styles.note}>
                <span className={styles.glyph} aria-hidden>checklist</span>
                <div>
                  <b>Have these ready (about 15 minutes in Twilio):</b>
                  <ul className={styles.list}>
                    <li>Your ABN or ACN</li>
                    <li>ASIC company extract, the long form (from the ASIC website)</li>
                    <li>Your business address in Australia (not a PO Box) and a bill or lease that shows it</li>
                    <li>ID of the person signing up (passport or driver licence)</li>
                    <li>A card for Twilio. A free trial account can’t text your customers.</li>
                  </ul>
                </div>
              </div>
              <div className={styles.row}>
                <a className={styles.btn} href="https://www.twilio.com/try-twilio" target="_blank" rel="noreferrer">Open Twilio sign-up ↗</a>
                <span className={styles.muted}>In Twilio: Account → API keys → Create API key (Standard). Paste its SID and secret here with your Account SID.</span>
              </div>
              <ConnectTwilioForm />
            </>
          ) : (
            <p className={styles.muted}>An owner or admin connects the agency’s Twilio here.</p>
          )}
        </section>

        {/* 2. Business check */}
        <section className={`${styles.step} ${a ? '' : styles.stepOff}`} aria-labelledby="s2">
          <div className={styles.stepHead}>
            <span className={`${styles.stepNum} ${approved ? styles.stepDone : ''}`}>{approved ? '✓' : '2'}</span>
            <h2 id="s2" className={styles.stepTitle}>Twilio checks your business</h2>
            <span className={styles.stepRight}>{a ? <span className={`${styles.pill} ${KYC_WORDS[a.kycStatus].cls}`}>{KYC_WORDS[a.kycStatus].label}</span> : null}</span>
          </div>
          {!a ? (
            <p className={styles.muted}>Starts when you connect. You upload the documents in Twilio; the status shows here.</p>
          ) : approved ? (
            <p className={styles.muted}>Twilio approved the business{a.kycCheckedAt ? `, checked ${a.kycCheckedAt.toLocaleString('en-AU')}` : ''}.</p>
          ) : (
            <>
              <p className={`${styles.note} ${a.kycStatus === 'needs_fix' ? styles.noteBad : styles.noteWarn}`}>
                <span className={styles.glyph} aria-hidden>{a.kycStatus === 'needs_fix' ? 'error' : 'hourglass_top'}</span>
                <span>
                  {a.kycNote ??
                    (a.kycStatus === 'pending'
                      ? 'Twilio is reviewing your documents. It usually takes a few business days. We check every hour.'
                      : 'Upload your business documents in Twilio (Regulatory Compliance → Australia, mobile numbers), then check again here.')}
                </span>
              </p>
              {view.canManage ? (
                <div className={styles.row}>
                  <a className={styles.btn} href="https://console.twilio.com/us1/develop/phone-numbers/regulatory-compliance/bundles" target="_blank" rel="noreferrer">Open Twilio ↗</a>
                  <KycCheckButton />
                </div>
              ) : null}
            </>
          )}
        </section>

        {/* 3. Numbers */}
        <section className={`${styles.step} ${approved ? '' : styles.stepOff}`} aria-labelledby="s3">
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>3</span>
            <h2 id="s3" className={styles.stepTitle}>A number for each agent</h2>
            <span className={styles.stepRight}>{approved ? <span className={`${styles.pill} ${live ? styles.ok : ''}`}>{live} of {view.agents.length} live</span> : null}</span>
          </div>
          {!approved ? (
            <p className={styles.muted}>Available once Twilio approves your business.</p>
          ) : (
            <>
              <p className={styles.muted}>
                Each agent gets their own Australian mobile number on your Twilio account. Their missed calls forward to it, and their
                texts come from it. Twilio charges for each number monthly.
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr><th>Agent</th><th>Their mobile</th><th>Twilio number</th><th>Forwarding</th><th>Status</th><th /></tr>
                  </thead>
                  <tbody>
                    {view.agents.map((g) => (
                      <tr key={g.userId}>
                        <td><b>{g.name}</b></td>
                        <td className={styles.mono}>
                          {g.number?.callerId ?? g.mobile ?? <span className={styles.muted}>not in their profile</span>}{' '}
                          {g.number ? <span className={`${styles.pill} ${g.number.callerIdStatus === 'verified' ? styles.ok : styles.warn}`}>{g.number.callerIdStatus === 'verified' ? 'verified' : 'not verified'}</span> : null}
                        </td>
                        <td className={styles.mono}>{g.number?.display ?? '—'}</td>
                        <td>{g.number ? (g.number.forwardingTestedAt ? <span className={`${styles.pill} ${styles.ok}`}>tested {g.number.forwardingTestedAt.toLocaleDateString('en-AU')}</span> : <span className={styles.pill}>not yet</span>) : '—'}</td>
                        <td>{g.number ? (g.number.live ? <span className={`${styles.pill} ${styles.ok}`}>Live</span> : <span className={`${styles.pill} ${styles.warn}`}>Waiting on {g.name.split(' ')[0]}</span>) : <span className={styles.pill}>No number</span>}</td>
                        <td>{view.canManage ? (g.number ? <ReleaseNumberButton numberId={g.number.id} display={g.number.display} /> : <GetNumberButton agentUserId={g.userId} name={g.name} />) : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={styles.note}>
                <span className={styles.glyph} aria-hidden>info</span>
                <span>Each agent finishes on their own phone under <b>Connectors → My phone</b>: verify their mobile, turn on forwarding, and run a test call.</span>
              </p>
              <p className={`${styles.note} ${styles.noteWarn}`}>
                <span className={styles.glyph} aria-hidden>toggle_off</span>
                <span>Nothing is texted or called by itself. Automatic texts and AI call-backs come as skills you switch on in <Link href="/skills">Skills</Link>.</span>
              </p>
            </>
          )}
        </section>

        {me.number ? (
          <section className={styles.step} aria-labelledby="mine">
            <div className={styles.stepHead}>
              <h2 id="mine" className={styles.stepTitle}>Your own phone</h2>
            </div>
            <MyPhoneSteps view={me} codes={dialCodes(me.number.e164)} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
