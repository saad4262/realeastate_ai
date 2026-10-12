import type { Metadata } from 'next';
import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { listCustomerThreads } from '@repo/core/mail';
import { WebShell } from '../../../components/web-shell';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { requireWebUser } from '../../../lib/session';
import { sendVerificationAction } from './actions';
import { MailSync } from './islands';
import styles from './messages.module.css';

/** What the last verification step did, from `?verify=` — words only, no data. */
const VERIFY_NOTICE: Record<string, { text: string; bad?: boolean }> = {
  sent: { text: 'Check your email — we sent you a link. It works for 24 hours.' },
  done: { text: 'Thanks — your email is confirmed.' },
  wait: { text: 'We just sent one. Give it a minute before asking for another.', bad: true },
  failed: { text: 'We could not send the email just now. Try again shortly.', bad: true },
  unavailable: { text: 'Email is not set up on this site yet, so we cannot send the link.', bad: true },
  expired: { text: 'That link has expired or belongs to another account. Send a new one.', bad: true },
};

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your messages',
  robots: { index: false, follow: false },
};

/**
 * Every conversation this person has had with an agency (docs/adr/0016) —
 * what they sent through an enquiry or offer form, and every reply the agency
 * emailed back. The same messages are in their mail app; this is so they do
 * not have to go there.
 *
 * Email-matched conversations show only once the account has PROVED its
 * address by opening a link sent to it — sign-up here does not confirm an
 * email, and anybody can register with somebody else's. Until then, only what
 * this account itself sent (a private offer made while signed in) is shown.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).verify;
  const notice = VERIFY_NOTICE[Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')];
  await requireWebUser('/account/messages');
  const session = await ensureConsumerAccount();
  if (!session) return null;

  const { rows: threads, addressProved } = await listCustomerThreads(getWebDb(), {
    userId: session.id,
    email: session.email ?? '',
  });

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <Link href="/account" className={styles.back}>
          ← Your account
        </Link>
        <h1 className={styles.title}>Messages</h1>
        <p className={styles.sub}>Your enquiries, and every email an agency sent you — reply here or from your own email.</p>

        {notice ? (
          <p className={notice.bad ? styles.noticeBad : styles.notice} role="status">
            {notice.text}
          </p>
        ) : null}

        {!addressProved ? (
          <section className={styles.verify}>
            <h2 className={styles.cardLabel}>Confirm your email first</h2>
            <p className={styles.body}>
              To show the enquiries you sent and the replies agencies emailed to{' '}
              <strong>{session.email}</strong>, we need to check it is yours. Open the{' '}
              <em>View this conversation on the website</em> link in any agency&apos;s email — or
              we can email you a link now.
            </p>
            <form action={sendVerificationAction}>
              <button type="submit" className={styles.button}>
                Email me a link
              </button>
            </form>
          </section>
        ) : null}

        {threads.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>{addressProved ? 'No messages yet' : 'Nothing to show yet'}</p>
            <p className={styles.emptyHint}>
              When you enquire about a property, the conversation with the agent shows up here.
            </p>
          </div>
        ) : (
          <ul className={styles.list}>
            {threads.map((t) => (
              <li key={t.id} className={styles.item}>
                <Link href={`/account/messages/${t.id}`} className={`${styles.row} ${t.unread ? styles.rowNew : ''}`}>
                  <span className={styles.rowTop}>
                    <span className={styles.agency}>{t.agencyName}</span>
                    {t.unread ? <span className={styles.newPill}>New</span> : null}
                    <time className={styles.when} dateTime={t.lastActivityAt.toISOString()}>
                      <LocalTime iso={t.lastActivityAt.toISOString()} style="date" />
                    </time>
                  </span>
                  <span className={styles.subject}>{t.subject}</span>
                  {t.preview ? <span className={styles.preview}>{t.preview}</span> : null}
                  <span className={styles.replies}>
                    {t.replies === 0
                      ? 'Waiting for a reply'
                      : `${t.replies} ${t.replies === 1 ? 'reply' : 'replies'} from the agency`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <MailSync />

        {/* Saved-search emails already live in the app, on /alerts — every run
            that was sent is listed there with its listings. Pointing at it
            rather than copying it keeps one place for each kind of email. */}
        <section className={styles.card}>
          <h2 className={styles.cardLabel}>Alert emails</h2>
          <p className={styles.body}>Every new-listing email we have sent you is on your Alerts page.</p>
          <Link href="/alerts" className={styles.link}>
            Open your alerts
          </Link>
        </section>
      </main>
    </WebShell>
  );
}
