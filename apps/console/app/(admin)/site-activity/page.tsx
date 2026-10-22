import Link from 'next/link';
import { siteInsights, siteTrend, type SitePeriod, type SiteTrend } from '@repo/core/platform';
import { BarList, ColumnChart, Stat } from '@/components/admin/tables';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformAdmin } from '@/lib/require-platform-admin';

const PERIODS: { value: SitePeriod; label: string }[] = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 'all', label: 'All time' },
];

function parsePeriod(raw: string | string[] | undefined): SitePeriod {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === '7' ? 7 : v === '90' ? 90 : v === 'all' ? 'all' : 30;
}

/**
 * What the public site's visitors look for (ADR 0051): searches and listing
 * views by suburb, agency and listing. Recorded only since site_activity was
 * added; signed-in visitors by account, anonymous ones as counts. Searches the
 * property guide ran are counted beside them, from the saved chats.
 */
export default async function InsightsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { admin } = await requirePlatformAdmin();
  await recordPlatformView(admin, 'site_activity');
  const days = parsePeriod((await searchParams).days);
  const [s, trend] = await Promise.all([siteInsights(getConsoleDb(), admin, days), siteTrend(getConsoleDb(), admin, days)]);
  const t = s.totals;
  const share = (part: number, whole: number) => (whole ? ` (${Math.round((part / whole) * 100)}% signed in)` : '');
  const span = days === 'all' ? 'the last 12 months' : `the last ${days} days`;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Site activity</h1>
          <p className={styles.sub}>
            What visitors to the public site search for and open. Searches on the search page are recorded since tracking was switched on — not before.
          </p>
        </div>
        <nav className={styles.tabs} aria-label="Period">
          {PERIODS.map((p) => (
            <Link key={p.value} href={`/site-activity?days=${p.value}`} className={days === p.value ? styles.tabOn : styles.tab}>
              {p.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className={styles.stats}>
        <Stat label="Searches" value={t.searches} />
        <Stat label="Guide searches" value={t.guideSearches} />
        <Stat label="Listing views" value={t.views} />
        <Stat label="Active signed-in users" value={t.activeUsers} />
        <Stat label="New users" value={t.newUsers} />
        <Stat label="Enquiries" value={t.enquiries} />
      </div>
      <p className={styles.muted} style={{ margin: 0, fontSize: '0.8125rem' }}>
        Searches on the search page{share(t.signedInSearches, t.searches)} · guide searches are the property guide&apos;s, for signed-in
        visitors only · views{share(t.signedInViews, t.views)} · enquiries
        {t.enquiries ? ` (${t.signedInEnquiries} from signed-in users)` : ''}.
      </p>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Searches and listing views</h2>
            <p className={styles.sub}>Per {trend.bucket}, Sydney time, {span}. Guide searches included.</p>
          </div>
          <ColumnChart
            label={`Searches and listing views per ${trend.bucket}, ${span}`}
            points={trendPoints(trend, (p) => p.searches + p.views, (p) => `${p.searches} searches · ${p.views} views`)}
          />
        </section>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Enquiries</h2>
            <p className={styles.sub}>Enquiries and offers sent from the site, per {trend.bucket}, {span}.</p>
          </div>
          <ColumnChart
            label={`Enquiries per ${trend.bucket}, ${span}`}
            points={trendPoints(trend, (p) => p.enquiries, (p) => `${p.enquiries} ${p.enquiries === 1 ? 'enquiry' : 'enquiries'}`)}
          />
        </section>
      </div>

      <section className={styles.card}>
        <div className={styles.cardBody}>
          <h2 className={styles.h2}>Searches by suburb</h2>
          <p className={styles.sub}>Every suburb searched or opened in the period, most searched first.</p>
        </div>
        {s.suburbs.length === 0 ? (
          <p className={styles.empty}>Nothing recorded yet.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Suburb</th>
                  <th className={styles.num}>Searches</th>
                  <th className={styles.num}>Guide searches</th>
                  <th className={styles.num}>Total searches</th>
                  <th className={styles.num}>Listing views</th>
                </tr>
              </thead>
              <tbody>
                {s.suburbs.map((r) => (
                  <tr key={`${r.suburb}-${r.state}`}>
                    <td className={styles.name}>{r.suburb}{r.state ? `, ${r.state}` : ''}</td>
                    <td data-label="Searches" className={styles.num}>{r.searches}</td>
                    <td data-label="Guide searches" className={styles.num}>{r.guideSearches}</td>
                    <td data-label="Total searches" className={styles.num}>{r.searches + r.guideSearches}</td>
                    <td data-label="Listing views" className={styles.num}>{r.views}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Agencies drawing the most interest</h2>
            <p className={styles.sub}>Views of their listings.</p>
          </div>
          <BarList
            empty="Nothing recorded yet."
            rows={s.topAgencies.map((r) => ({
              key: r.agencyId,
              label: <Link href={`/agencies/${r.agencyId}`}>{r.name}</Link>,
              title: r.name,
              value: r.views,
              detail: `${r.views} views · ${r.enquiries} enquiries`,
            }))}
          />
        </section>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Most viewed listings</h2>
          </div>
          <BarList
            empty="Nothing recorded yet."
            rows={s.topListings.map((r) => ({
              key: r.listingId,
              label: `${r.address ?? 'Listing'}${r.agencyName ? ` — ${r.agencyName}` : ''}`,
              title: r.address ?? 'Listing',
              value: r.views,
              detail: `${r.views} views`,
            }))}
          />
        </section>
      </div>
    </div>
  );
}

const DAY = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * One measure of the trend as chart columns. A bucket's start is a Sydney calendar date, so it is
 * read and printed as UTC to keep that date. Thirty daily ticks do not fit under a half-width card,
 * so a daily chart that long labels every fourth day, counted back from today (an even step,
 * because ColumnChart already prints only every other tick).
 */
function trendPoints(trend: SiteTrend, value: (p: SiteTrend['points'][number]) => number, detail: (p: SiteTrend['points'][number]) => string) {
  const last = trend.points.length - 1;
  const sparse = trend.bucket === 'day' && trend.points.length > 14;
  return trend.points.map((p, i) => {
    const start = new Date(`${p.start}T00:00:00Z`);
    const date = trend.bucket === 'month' ? MONTH.format(start) : DAY.format(start);
    return {
      key: p.start,
      tick: sparse && (last - i) % 4 !== 0 ? '' : date,
      title: `${trend.bucket === 'week' ? 'Week of ' : ''}${date}: ${detail(p)}`,
      value: value(p),
    };
  });
}
