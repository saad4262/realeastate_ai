import type { Metadata } from 'next';
import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { APPOINTMENT_TYPE_LABELS, listCustomerMeetings, type CustomerMeeting } from '@repo/core/appointments';
import { listCustomerThreads } from '@repo/core/mail';
import { WebShell } from '../../../components/web-shell';
import { ensureConsumerAccount } from '../../../lib/account';
import { getWebDb } from '../../../lib/db';
import { requireWebUser } from '../../../lib/session';
import shared from '../messages/messages.module.css';
import styles from './meetings.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Meetings and notifications',
  robots: { index: false, follow: false },
};

/** A meeting counts as "starting soon" this long before it starts; Join is offered throughout. */
const SOON_MS = 30 * 60_000;

/**
 * A buyer's meetings and the latest emails from agencies (ADR 0032 §5).
 *
 * The meetings are the ones an agency INVITED them to, at an address they
 * have proved — `listCustomerMeetings` decides, with the same proof as
 * /account/messages. The emails are that page's own list, newest first, cut
 * to five; it is the one place each conversation is read.
 *
 * Rendered per request (no cache): "starting soon" is about now.
 */
export default async function MeetingsPage() {
  await requireWebUser('/account/meetings');
  const session = await ensureConsumerAccount();
  if (!session) return null;

  const who = { userId: session.id, email: session.email ?? '' };
  const now = new Date();
  // Independent reads, started together (§ 5).
  const [meetings, threads] = await Promise.all([
    listCustomerMeetings(getWebDb(), who, { now }),
    listCustomerThreads(getWebDb(), who, { limit: 5 }),
  ]);
  const soon = meetings.rows.filter((m) => m.status !== 'cancelled' && m.startsAt.getTime() - now.getTime() <= SOON_MS);

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={shared.page}>
        <Link href="/account" className={shared.back}>
          ← Your account
        </Link>
        <h1 className={shared.title}>Meetings and notifications</h1>
        <p className={shared.sub}>Meetings agencies have invited you to, and their latest emails.</p>

        {soon.map((m) => (
          <section key={`soon-${m.id}`} className={styles.banner} role="status">
            <p className={styles.bannerTitle}>
              {m.startsAt.getTime() <= now.getTime() ? 'Happening now' : 'Starting soon'}: {m.title}
            </p>
            <span className={styles.meetingMeta}>
              {m.agencyName}
              {m.agentName ? ` · ${m.agentName}` : ''} ·{' '}
              <LocalTime iso={m.startsAt.toISOString()} style="full" />
            </span>
            {m.meetingUrl ? (
              <span className={styles.actions}>
                <a href={m.meetingUrl} target="_blank" rel="noopener noreferrer" className={styles.join}>
                  Join the meeting ↗
                </a>
              </span>
            ) : null}
          </section>
        ))}

        {!meetings.addressProved ? (
          <section className={shared.verify}>
            <h2 className={shared.cardLabel}>Confirm your email first</h2>
            <p className={shared.body}>
              Meetings show here once we know <strong>{session.email}</strong> is yours — the same
              check as your messages. Open the link in any agency&apos;s email, or ask for one on
              the Messages page.
            </p>
            <Link href="/account/messages" className={shared.link}>
              Go to Messages
            </Link>
          </section>
        ) : null}

        <section className={styles.section} aria-labelledby="meetings-heading">
          <div className={styles.sectionHead}>
            <h2 id="meetings-heading" className={styles.sectionTitle}>
              Upcoming meetings
            </h2>
          </div>
          {meetings.rows.length === 0 ? (
            <div className={shared.empty}>
              <p className={shared.emptyTitle}>No meetings booked</p>
              <p className={shared.emptyHint}>When an agent invites you to a meeting, it shows up here with a Join button.</p>
            </div>
          ) : (
            <ul className={shared.list}>
              {meetings.rows.map((m) => (
                <li key={m.id} className={`${shared.item} ${m.status === 'cancelled' ? styles.cancelled : ''}`}>
                  <MeetingRow m={m} now={now} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section} aria-labelledby="emails-heading">
          <div className={styles.sectionHead}>
            <h2 id="emails-heading" className={styles.sectionTitle}>
              Latest emails
            </h2>
            <Link href="/account/messages" className={styles.more}>
              All messages →
            </Link>
          </div>
          {threads.rows.length === 0 ? (
            <div className={shared.empty}>
              <p className={shared.emptyTitle}>No emails yet</p>
              <p className={shared.emptyHint}>Emails from agencies — invitations, reminders and replies — show up here.</p>
            </div>
          ) : (
            <ul className={shared.list}>
              {threads.rows.map((t) => (
                <li key={t.id} className={shared.item}>
                  <Link href={`/account/messages/${t.id}`} className={shared.row}>
                    <span className={shared.rowTop}>
                      <span className={shared.agency}>{t.agencyName}</span>
                      <time className={shared.when} dateTime={t.lastActivityAt.toISOString()}>
                        <LocalTime iso={t.lastActivityAt.toISOString()} style="short" />
                      </time>
                    </span>
                    <span className={shared.subject}>{t.subject}</span>
                    {t.preview ? <span className={shared.preview}>{t.preview}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </WebShell>
  );
}

function MeetingRow({ m, now }: { m: CustomerMeeting; now: Date }) {
  const live = m.startsAt.getTime() <= now.getTime();
  const soon = !live && m.startsAt.getTime() - now.getTime() <= SOON_MS;
  const cancelled = m.status === 'cancelled';
  return (
    <div className={styles.meeting}>
      <div className={styles.meetingTop}>
        <span className={styles.meetingTitle}>{m.title}</span>
        {cancelled ? (
          <span className={`${styles.badge} ${styles.off}`}>Cancelled</span>
        ) : live ? (
          <span className={`${styles.badge} ${styles.live}`}>Now</span>
        ) : soon ? (
          <span className={`${styles.badge} ${styles.soon}`}>Starting soon</span>
        ) : null}
      </div>
      <time className={styles.meetingWhen} dateTime={m.startsAt.toISOString()}>
        <LocalTime iso={m.startsAt.toISOString()} style="full" />
      </time>
      <span className={styles.meetingMeta}>
        {APPOINTMENT_TYPE_LABELS[m.type]} with {m.agentName ?? 'your agent'} · {m.agencyName}
        {m.location ? ` · ${m.location}` : ''}
      </span>
      {!cancelled && m.meetingUrl ? (
        <span className={styles.actions}>
          <a href={m.meetingUrl} target="_blank" rel="noopener noreferrer" className={styles.join}>
            Join ↗
          </a>
        </span>
      ) : null}
    </div>
  );
}
