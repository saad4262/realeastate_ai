import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { APPOINTMENT_TYPE_LABELS, listAppointments } from '@repo/core/appointments';
import type { Actor } from '@repo/core/permissions';
import { getConsoleDb } from '../../lib/db';
import styles from './upcoming-meetings.module.css';

const SOON_MS = 30 * 60_000;

/**
 * The next few meetings, at the top of the person's home screen (ADR 0032):
 * the agency's for an owner/admin, their own for anyone else — that is
 * `listAppointments`' rule, not this file's — team meetings they are on
 * included (ADR 0038), except one they declined. One statement; streams behind the
 * caller's Suspense, so the page never waits on it. Nothing booked → nothing
 * drawn.
 */
export async function UpcomingMeetings({ actor, surface }: { actor: Actor; surface: 'agency' | 'agent' }) {
  const now = new Date();
  const page = await listAppointments(getConsoleDb(), actor, { when: 'upcoming', limit: 6, now }).catch(() => null);
  const rows = (page?.rows ?? []).filter((a) => !a.participants.some((p) => p.userId === actor.userId && p.declined)).slice(0, 5);
  if (!page || !rows.length) return null;
  const calendar = surface === 'agency' ? '/calendar' : '/my-calendar';
  const contacts = surface === 'agency' ? '/customers' : '/my-contacts';

  return (
    <section className={styles.card} aria-labelledby="upcoming-meetings">
      <div className={styles.head}>
        <h2 id="upcoming-meetings" className={styles.title}>
          Upcoming meetings
        </h2>
        <Link href={calendar} className={styles.all}>
          See all →
        </Link>
      </div>
      <ul className={styles.list}>
        {rows.map((a) => {
          const live = a.startsAt.getTime() <= now.getTime();
          const soon = !live && a.startsAt.getTime() - now.getTime() <= SOON_MS;
          return (
            <li key={a.id} className={styles.row}>
              <time dateTime={a.startsAt.toISOString()} className={styles.when}>
                <LocalTime iso={a.startsAt.toISOString()} style="full" />
              </time>
              <div className={styles.what}>
                <span className={styles.name}>{a.title}</span>
                {a.contactId ? (
                  <span className={styles.meta}>
                    {APPOINTMENT_TYPE_LABELS[a.type]} · with{' '}
                    <Link href={`${contacts}/${a.contactId}`}>{a.contactName}</Link>
                    {page.seesAll && a.assignedAgentName ? ` · ${a.assignedAgentName}` : ''}
                  </span>
                ) : (
                  <span className={styles.meta}>
                    Team meeting · with{' '}
                    {[a.assignedAgentName, ...a.participants.filter((p) => !p.declined).map((p) => p.name)]
                      .filter((n): n is string => Boolean(n))
                      .join(', ')}
                  </span>
                )}
              </div>
              <div className={styles.side}>
                {live ? <span className={styles.now}>Now</span> : soon ? <span className={styles.soon}>Starting soon</span> : null}
                {a.meetingUrl ? (
                  <a href={a.meetingUrl} target="_blank" rel="noopener noreferrer" className={styles.join}>
                    Join ↗
                  </a>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
