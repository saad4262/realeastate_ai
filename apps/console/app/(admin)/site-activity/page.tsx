import Link from 'next/link';
import { siteInsights } from '@repo/core/platform';
import { BarList, Stat } from '@/components/admin/tables';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformAdmin } from '@/lib/require-platform-admin';

/**
 * What the public site's visitors look for (ADR 0051): searches and listing
 * views by suburb, agency and listing. Recorded only since site_activity was
 * added; signed-in visitors by account, anonymous ones as counts.
 */
export default async function InsightsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { admin } = await requirePlatformAdmin();
  await recordPlatformView(admin, 'site_activity');
  const raw = (await searchParams).days;
  const v = Array.isArray(raw) ? raw[0] : raw;
  const days = v === '7' ? 7 : v === '90' ? 90 : 30;
  const s = await siteInsights(getConsoleDb(), admin, days);
  const t = s.totals;
  const share = (part: number, whole: number) => (whole ? ` (${Math.round((part / whole) * 100)}% signed in)` : '');

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Site activity</h1>
          <p className={styles.sub}>
            What visitors to the public site search for and open. Recorded since tracking was switched on — not before.
          </p>
        </div>
        <nav className={styles.tabs} aria-label="Period">
          {([7, 30, 90] as const).map((d) => (
            <Link key={d} href={`/site-activity?days=${d}`} className={days === d ? styles.tabOn : styles.tab}>
              {d} days
            </Link>
          ))}
        </nav>
      </div>

      <div className={styles.stats}>
        <Stat label="Searches" value={t.searches} />
        <Stat label="Listing views" value={t.views} />
        <Stat label="Active signed-in users" value={t.activeUsers} />
        <Stat label="New users" value={t.newUsers} />
        <Stat label="Enquiries from users" value={t.enquiries} />
      </div>
      <p className={styles.muted} style={{ margin: 0, fontSize: '0.8125rem' }}>
        Searches{share(t.signedInSearches, t.searches)} · views{share(t.signedInViews, t.views)}.
      </p>

      <div className={styles.grid2}>
        <section className={styles.card}>
          <div className={styles.cardBody}>
            <h2 className={styles.h2}>Most searched suburbs</h2>
            <p className={styles.sub}>Searches and listing views together.</p>
          </div>
          <BarList
            empty="Nothing recorded yet."
            rows={s.topSuburbs.map((r) => ({
              key: `${r.suburb}-${r.state}`,
              label: `${r.suburb}${r.state ? `, ${r.state}` : ''}`,
              title: r.suburb,
              value: r.searches + r.views,
              detail: `${r.searches} searches · ${r.views} views`,
            }))}
          />
        </section>
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
      </div>

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
  );
}
