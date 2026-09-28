import type { Metadata } from 'next';
import Link from 'next/link';
import { describeCadence, listRunsForUser, listSchedules } from '@repo/core/schedules';
import { priceLabel } from '@repo/core/listings/format';
import type { PublicListingSummary } from '@repo/core/listings';
import { ensureConsumerAccount } from '../../lib/account';
import { getWebDb } from '../../lib/db';
import { requireWebUser } from '../../lib/session';
import { WebShell } from '../../components/web-shell';
import { ScheduleRow } from './schedule-row';
import styles from './alerts.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'My alerts',
  robots: { index: false, follow: false },
};

export default async function AlertsPage() {
  // Middleware already redirects an anonymous visitor here, so this is the
  // second line rather than the first — and it creates the `user` row that
  // the schedule foreign key needs.
  await requireWebUser('/alerts');
  const user = await ensureConsumerAccount();
  if (!user) return null;

  const db = getWebDb();
  const actor = { userId: user.id };

  // Independent reads, started together (§ 5).
  const [schedules, runs] = await Promise.all([
    listSchedules(db, actor),
    listRunsForUser(db, actor, { limit: 20 }),
  ]);

  /**
   * What was emailed, not what was `delivered`.
   *
   * A run that finds nothing new is still recorded `empty` — that is what
   * the SEARCH found — but it now sends an email anyway. Keeping the old
   * `status === 'delivered'` filter here would have made this section quietly
   * disagree with the inbox it is describing: the page says "everything we
   * have sent", so it lists what was sent.
   *
   * Historical rows read correctly too: the old empty runs recorded
   * `email_status: 'skipped'` and stay hidden, because no email was sent for
   * them either.
   */
  const delivered = runs.filter((run) => run.emailStatus === 'sent');

  return (
    /*
      /alerts had no header at all until this — no brand, no nav, no way
      back to the site except the browser's back button. It was the one
      account page that rendered its own <main> instead of going through
      the shell, which is also why the account control had nowhere to sit.
    */
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
      {/*
        Title + CTA on one grid row; the sentence on the next, spanning both
        columns. Putting that sentence inside a flex item next to the button
        was what wrapped it one word per line.
      */}
      <header className={styles.head}>
        <h1 className={styles.title}>My alerts</h1>
        <Link href="/search" className={styles.cta}>
          Save a new search
        </Link>
        <p className={styles.sub}>Saved searches we run for you, and everything we have sent.</p>
      </header>

      <section className={styles.section}>
        <h2 className={styles.sectionLabel}>Saved searches</h2>

        {schedules.length === 0 ? (
          <div className={styles.emptyDashed}>
            <p className={styles.emptyTitle}>You have no saved searches yet</p>
            <p className={styles.emptyBody}>
              Run a search, then press <strong>Save this search</strong> and pick a time. We will do
              it for you and email you what is new.
            </p>
            <Link href="/search" className={styles.emptyCta}>
              Start a search
            </Link>
          </div>
        ) : (
          <ul className={styles.list}>
            {schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                id={schedule.id}
                name={schedule.name}
                description={schedule.description}
                searchPath={schedule.searchPath}
                status={schedule.status}
                cadence={describeCadence(schedule)}
                nextRunAt={schedule.nextRunAt.toISOString()}
                failures={schedule.consecutiveFailures}
                timing={{
                  cadence: schedule.cadence,
                  sendAtMinute: schedule.sendAtMinute,
                  sendOnWeekday: schedule.sendOnWeekday,
                  intervalMinutes: schedule.intervalMinutes,
                  timezone: schedule.timezone,
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionLabel}>Recently sent</h2>

        {delivered.length === 0 ? (
          <p className={styles.empty}>
            Nothing has been sent yet. A saved search emails you the first time it finds something
            new — not before.
          </p>
        ) : (
          <ul className={styles.list}>
            {delivered.map((run) => {
              // jsonb hands these back as plain objects; the snapshot is what
              // was true when the run went out and is never re-read from the
              // live tables, so a listing withdrawn since still shows as sent.
              const listings = (run.listings ?? []) as unknown as PublicListingSummary[];
              const ranAt = new Date(run.createdAt);

              return (
                <li
                  key={run.id}
                  className="rounded-2xl border border-line bg-card p-5 shadow-[0_1px_2px_rgba(11,61,46,0.04)]"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold text-ink">
                      {run.newCount} new {run.newCount === 1 ? 'listing' : 'listings'}
                    </p>
                    <time
                      dateTime={ranAt.toISOString()}
                      className="text-xs text-ink-faint"
                      suppressHydrationWarning
                    >
                      {ranAt.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}
                    </time>
                  </div>

                  {run.summary ? (
                    <p className="mt-2 text-sm leading-relaxed text-ink-soft">{run.summary}</p>
                  ) : null}
                  {run.summarySource === 'model' ? (
                    <p className="mt-1 text-xs text-ink-faint">Written by the property guide</p>
                  ) : null}

                  {listings.length > 0 ? (
                    <ul className="mt-3 list-none space-y-1.5 border-t border-line-subtle p-0 pt-3">
                      {listings.slice(0, 4).map((listing) => (
                        <li key={listing.id} className="text-sm">
                          <Link href={`/listing/${listing.id}`} className="text-ink hover:underline">
                            <span className="font-semibold">{priceLabel(listing)}</span>
                            <span className="text-ink-soft">
                              {' '}
                              — {listing.address}, {listing.suburb}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                    <Link
                      href={`/chat?alert=${run.id}`}
                      className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:bg-brand-deep"
                    >
                      Continue this search
                    </Link>
                    {run.emailStatus === 'failed' ? (
                      <span className="text-notice">
                        The email did not send — these results are still here.
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      </main>
    </WebShell>
  );
}
