import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { listAgencies, platformAttention, platformTotals, siteInsights } from '@repo/core/platform';
import { AgencyTable, BarList, ColumnChart, Stat } from '@/components/admin/tables';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformAdmin } from '@/lib/require-platform-admin';

const WEEK = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' });

/** The admin home: the platform in numbers, what needs attention, leads per week, where visitors look, newest agencies. */
export default async function PlatformHomePage() {
  const { admin } = await requirePlatformAdmin();
  await recordPlatformView(admin, 'overview');
  const db = getConsoleDb();
  const [totals, newest, { attention, weeklyLeads }, site] = await Promise.all([
    platformTotals(db, admin),
    listAgencies(db, admin, { limit: 8 }),
    platformAttention(db, admin),
    siteInsights(db, admin, 30),
  ]);
  const nothingNeedsYou =
    attention.trialsEnding.length === 0 && attention.suspended.length === 0 && attention.failedMail.length === 0 && attention.blockedMembers === 0;

  return (
    <div className={styles.wrap}>
      <div className={styles.headText}>
        <h1 className={styles.title}>Platform overview</h1>
        <p className={styles.sub}>Every agency, agent and user. Every page you open and every change you make is recorded.</p>
      </div>

      <div className={styles.stats}>
        <Stat label="Agencies" value={totals.agencies} />
        <Stat label="Active members" value={totals.activeMembers} />
        <Stat label="Live listings" value={totals.liveListings} />
        <Stat label="Leads (7 days)" value={totals.leads7d} />
        <Stat label="Leads (30 days)" value={totals.leads30d} />
        <Stat label="Meetings next 7 days" value={totals.meetingsNext7d} />
        <Stat label="Site searches (30 days)" value={site.totals.searches} />
      </div>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Needs your attention</h2>
          </div>
          {nothingNeedsYou ? (
            <p className={styles.empty}>Nothing — no trial ending in the next 14 days, nothing suspended, no failed email today.</p>
          ) : (
            <ul className={styles.attention}>
              {attention.trialsEnding.map((a) => (
                <li key={`t-${a.agencyId}`}>
                  <span className={styles.badgeWarn}>Trial ends</span>
                  <Link href={`/agencies/${a.agencyId}`}>{a.name}</Link>
                  <span className={styles.muted}><LocalTime iso={a.trialEndsAt.toISOString()} style="date" /></span>
                </li>
              ))}
              {attention.suspended.map((a) => (
                <li key={`s-${a.agencyId}`}>
                  <span className={styles.badgeBad}>Suspended</span>
                  <Link href={`/agencies/${a.agencyId}`}>{a.name}</Link>
                  {a.reason ? <span className={styles.muted}>{a.reason}</span> : null}
                </li>
              ))}
              {attention.failedMail.map((a) => (
                <li key={`f-${a.agencyId}`}>
                  <span className={styles.badgeBad}>{a.failed} failed {a.failed === 1 ? 'email' : 'emails'} today</span>
                  <Link href={`/agencies/${a.agencyId}/emails?days=7`}>{a.name}</Link>
                </li>
              ))}
              {attention.blockedMembers > 0 ? (
                <li>
                  <span className={styles.badge}>{attention.blockedMembers} blocked {attention.blockedMembers === 1 ? 'member' : 'members'}</span>
                  <Link href="/agents">See agents</Link>
                </li>
              ) : null}
            </ul>
          )}
        </section>

        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Leads per week</h2>
            <p className={styles.sub}>Every agency, the last 12 weeks.</p>
          </div>
          <ColumnChart
            label="Leads per week, last 12 weeks"
            points={weeklyLeads.map((w) => ({
              key: w.weekStart.toISOString(),
              tick: WEEK.format(w.weekStart),
              title: `Week of ${WEEK.format(w.weekStart)}`,
              value: w.leads,
            }))}
          />
        </section>
      </div>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <div className={styles.head}>
              <h2 className={styles.h2}>Where visitors look (30 days)</h2>
              <Link href="/site-activity" className={styles.btn}>Site activity →</Link>
            </div>
          </div>
          <BarList
            empty="No searches recorded yet."
            rows={site.topSuburbs.slice(0, 6).map((r) => ({
              key: `${r.suburb}-${r.state}`,
              label: `${r.suburb}${r.state ? `, ${r.state}` : ''}`,
              title: r.suburb,
              value: r.searches + r.views,
              detail: `${r.searches + r.views}`,
            }))}
          />
        </section>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Agencies drawing the most interest (30 days)</h2>
          </div>
          <BarList
            empty="No listing views recorded yet."
            rows={site.topAgencies.slice(0, 6).map((r) => ({
              key: r.agencyId,
              label: <Link href={`/agencies/${r.agencyId}`}>{r.name}</Link>,
              title: r.name,
              value: r.views,
              detail: `${r.views} views`,
            }))}
          />
        </section>
      </div>

      <section className={styles.card}>
        <div className={styles.cardBody}>
          <div className={styles.head}>
            <h2 className={styles.h2}>Newest agencies</h2>
            <Link href="/agencies" className={styles.btn}>All agencies →</Link>
          </div>
        </div>
        <AgencyTable rows={newest.rows} />
      </section>
    </div>
  );
}
