import Link from 'next/link';
import { getMyPhone, PhoneError } from '@repo/core/phone';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { MyPhoneSteps } from './my-phone-steps';
import { dialCodes, keysOrNull } from './phone-setup-screen';
import styles from './phone.module.css';

/** Connectors → My phone (ADR 0070): an agent's own phone side. Their number is the agency's to give. */
export async function MyPhoneScreen() {
  const session = await requireConsoleAccess('agent');
  let view: Awaited<ReturnType<typeof getMyPhone>>;
  try {
    view = await getMyPhone(getConsoleDb(), session.actor, { keys: keysOrNull() });
  } catch (err) {
    return <p role="alert">{err instanceof PhoneError ? err.message : 'Could not load your phone.'}</p>;
  }
  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <Link href="/my-integrations" className={styles.btnLink}>← Connectors</Link>
        <h1 className={contactStyles.title}>My phone</h1>
        <p className={contactStyles.sub}>
          Keep using your phone as normal. The calls you miss come here, and you can text people from your own number.
        </p>
      </div>
      {!view.connected ? (
        <p className={styles.note}>
          <span className={styles.glyph} aria-hidden>info</span>
          <span>Your agency hasn’t connected its Twilio yet. An owner or admin does that in Connectors → Phone &amp; SMS.</span>
        </p>
      ) : !view.number ? (
        <p className={styles.note}>
          <span className={styles.glyph} aria-hidden>info</span>
          <span>
            {view.kycStatus === 'approved'
              ? 'You don’t have a Twilio number yet. Ask an owner or admin to get you one in Connectors → Phone & SMS.'
              : 'Twilio is still checking your agency’s business. Once it approves, an owner or admin can get you a number.'}
          </span>
        </p>
      ) : (
        <section className={styles.step}>
          <MyPhoneSteps view={view} codes={dialCodes(view.number.e164)} />
        </section>
      )}
    </div>
  );
}
