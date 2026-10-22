import { cache, Suspense } from 'react';
import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import type { Actor } from '@repo/core/permissions';
import { listAgencies, ONLINE_MINUTES, platformAttention, platformPeople, platformTotals, siteInsights } from '@repo/core/platform';
import { AgencyTable, BarList, ColumnChart, LastSeen, Stat, StatusBadge } from '@/components/admin/tables';
import styles from '@/components/admin/admin.module.css';
import { SkeletonBar } from '@/components/page-skeleton';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformAdmin } from '@/lib/require-platform-admin';

const WEEK = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' });

/** Two sections read the site figures (the stats row and the interest bars); one statement set per request. */
const loadSite = cache((admin: Actor) => siteInsights(getConsoleDb(), admin, 30));

/**
 * The admin home: the platform in numbers, what needs attention, leads per week, where visitors look, newest agencies.
 *
 * The heading paints as soon as the view is recorded; every section below streams in on its own.
 * It used to wait for all fourteen statements behind one Promise.all, so the screen stayed on the
 * skeleton until the slowest had answered — and showed nothing at all if the function was cut off first.
 */
export default async function PlatformHomePage() {
  const { admin } = await requirePlatformAdmin();
  await recordPlatformView(admin, 'overview');

  return (
    <div className={styles.wrap}>
      <div className={styles.headText}>
        <h1 className={styles.title}>Platform overview</h1>
        <p className={styles.sub}>Every agency, agent and user. Every page you open and every change you make is recorded.</p>
      </div>

      <Suspense fallback={<SectionSkeleton height={560} />}>
        <PeopleSection admin={admin} />
      </Suspense>

      <Suspense fallback={<SectionSkeleton height={74} />}>
        <StatsSection admin={admin} />
      </Suspense>

      <Suspense fallback={<SectionSkeleton height={260} />}>
        <AttentionSection admin={admin} />
      </Suspense>

      <Suspense fallback={<SectionSkeleton height={260} />}>
        <InterestSection admin={admin} />
      </Suspense>

      <Suspense fallback={<SectionSkeleton height={320} />}>
        <NewestAgenciesSection admin={admin} />
      </Suspense>
    </div>
  );
}

function SectionSkeleton({ height }: { height: number }) {
  return <SkeletonBar height={height} radius="0.75rem" />;
}

async function PeopleSection({ admin }: { admin: Actor }) {
  const people = await platformPeople(getConsoleDb(), admin);
  return (
    <>
      <div className={styles.peopleGrid}>
        <Link href="/agencies" className={styles.peopleCard}>
          <span className={styles.statLabel}>Agencies</span>
          <span className={styles.statValue}>{people.agencies.total.toLocaleString('en-AU')}</span>
          <span className={styles.statOnline}>{people.agencies.online} online</span>
          <span className={styles.muted}>{people.agencies.suspended} suspended</span>
        </Link>
        <Link href="/agents" className={styles.peopleCard}>
          <span className={styles.statLabel}>Agents</span>
          <span className={styles.statValue}>{people.agents.total.toLocaleString('en-AU')}</span>
          <span className={styles.statOnline}>{people.agents.online} online</span>
          <span className={styles.muted}>{people.agents.blocked} blocked</span>
        </Link>
        <Link href="/users" className={styles.peopleCard}>
          <span className={styles.statLabel}>Users</span>
          <span className={styles.statValue}>{people.users.total.toLocaleString('en-AU')}</span>
          <span className={styles.statOnline}>{people.users.online} online</span>
          <span className={styles.muted}>{people.users.blocked} blocked</span>
        </Link>
        <Link href="/emails" className={styles.peopleCard}>
          <span className={styles.statLabel}>Email</span>
          <span className={styles.h2}>Write to everyone →</span>
          <span className={styles.muted}>agencies, agents or users</span>
        </Link>
      </div>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Online now</h2>
            <p className={styles.sub}>Seen in the last {ONLINE_MINUTES} minutes.</p>
          </div>
          {people.onlineNow.length === 0 ? (
            <p className={styles.empty}>Nobody right now.</p>
          ) : (
            <ul className={styles.attention}>
              {people.onlineNow.map((p) => (
                <li key={p.userId}>
                  <span className={styles.online}>{p.kind === 'member' ? 'Agent' : 'User'}</span>
                  <Link href={p.kind === 'member' && p.agencyId ? `/agencies/${p.agencyId}/agents/${p.userId}` : `/users/${p.userId}`}>{p.name}</Link>
                  <span className={styles.muted}>{p.agencyName ? `${p.agencyName}${p.role ? ` · ${p.role}` : ''}` : p.email}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>New members</h2>
          </div>
          {people.recentMembers.length === 0 ? (
            <p className={styles.empty}>None yet.</p>
          ) : (
            <table className={styles.table}>
              <tbody>
                {people.recentMembers.map((m) => (
                  <tr key={`${m.agencyId}-${m.userId}`}>
                    <td>
                      <Link className={styles.name} href={`/agencies/${m.agencyId}/agents/${m.userId}`}>{m.name}</Link>
                      <div className={styles.muted}>{m.role} · {m.agencyName}</div>
                    </td>
                    <td data-label="Joined"><LocalTime iso={m.joinedAt.toISOString()} style="date" /></td>
                    <td data-label="Last seen"><LastSeen at={m.lastSeenAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>New agencies</h2>
          </div>
          {people.recentAgencies.length === 0 ? (
            <p className={styles.empty}>None yet.</p>
          ) : (
            <table className={styles.table}>
              <tbody>
                {people.recentAgencies.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link className={styles.name} href={`/agencies/${a.id}`}>{a.name}</Link>
                      <div className={styles.muted}>{a.owner ?? 'No owner'}</div>
                    </td>
                    <td data-label="Status"><StatusBadge status={a.status} /></td>
                    <td data-label="Joined"><LocalTime iso={a.createdAt.toISOString()} style="date" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>New users</h2>
          </div>
          {people.recentUsers.length === 0 ? (
            <p className={styles.empty}>None yet.</p>
          ) : (
            <table className={styles.table}>
              <tbody>
                {people.recentUsers.map((u) => (
                  <tr key={u.userId}>
                    <td>
                      <Link className={styles.name} href={`/users/${u.userId}`}>{u.name}</Link>
                      {u.blocked ? <> <span className={styles.badgeBad}>Blocked</span></> : null}
                      <div className={styles.muted}>{u.email}</div>
                    </td>
                    <td data-label="Joined"><LocalTime iso={u.createdAt.toISOString()} style="date" /></td>
                    <td data-label="Last seen"><LastSeen at={u.lastSeenAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

async function StatsSection({ admin }: { admin: Actor }) {
  const [totals, site] = await Promise.all([platformTotals(getConsoleDb(), admin), loadSite(admin)]);
  return (
    <div className={styles.stats}>
      <Stat label="Live listings" value={totals.liveListings} />
      <Stat label="Leads (7 days)" value={totals.leads7d} />
      <Stat label="Leads (30 days)" value={totals.leads30d} />
      <Stat label="Meetings next 7 days" value={totals.meetingsNext7d} />
      <Stat label="Site searches (30 days)" value={site.totals.searches} />
    </div>
  );
}

async function AttentionSection({ admin }: { admin: Actor }) {
  const { attention, weeklyLeads } = await platformAttention(getConsoleDb(), admin);
  const nothingNeedsYou =
    attention.trialsEnding.length === 0 && attention.suspended.length === 0 && attention.failedMail.length === 0 && attention.blockedMembers === 0;
  return (
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
  );
}

async function InterestSection({ admin }: { admin: Actor }) {
  const site = await loadSite(admin);
  return (
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
  );
}

async function NewestAgenciesSection({ admin }: { admin: Actor }) {
  const newest = await listAgencies(getConsoleDb(), admin, { limit: 8 });
  return (
    <section className={styles.card}>
      <div className={styles.cardBody}>
        <div className={styles.head}>
          <h2 className={styles.h2}>Newest agencies</h2>
          <Link href="/agencies" className={styles.btn}>All agencies →</Link>
        </div>
      </div>
      <AgencyTable rows={newest.rows} />
    </section>
  );
}
