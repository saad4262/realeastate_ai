import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { getListingActivity, LISTING_ACTIVITY_DAYS, LISTING_ACTIVITY_PAGE_SIZE, ListingActivityError, parseActivityDays, type ListingActivityPerson } from '@repo/core/activity';
import type { Actor } from '@repo/core/permissions';
import { getConsoleDb } from '../../lib/db';
import styles from './contacts.module.css';

/**
 * Listing activity (ADR 0083 §6): who looked at these listings. Shared by the agency's and the agent's page, and the
 * admin's view of an agency; what each of them gets is decided in packages/core. The URL holds the period and the page.
 */

const DID: Record<ListingActivityPerson['kind'], string> = { view: 'Viewed', search: 'Searched', saved: 'Saved' };

export async function ListingActivityPage({
  actor,
  basePath,
  contactBase,
  scopeWords,
  searchParams,
}: {
  actor: Actor;
  basePath: string;
  /** Where a customer's profile lives on this surface. */
  contactBase: string;
  scopeWords: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const days = parseActivityDays(one(sp.days));
  const pageNo = Math.max(1, Number(one(sp.page)) || 1);
  let data;
  try {
    data = await getListingActivity(getConsoleDb(), actor, { days, page: pageNo });
  } catch (err) {
    if (err instanceof ListingActivityError) return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>{err.message}</p>;
    throw err;
  }
  const href = (d: number, p = 1) => `${basePath}?${new URLSearchParams({ days: String(d), ...(p > 1 ? { page: String(p) } : {}) })}`;
  const pages = Math.max(1, Math.ceil(data.peopleTotal / LISTING_ACTIVITY_PAGE_SIZE));

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Listing activity</h1>
          <p className={styles.sub}>Who looked at {scopeWords}. Signed-in people by name; everyone else is a count.</p>
        </div>
        <nav className={styles.inlineFields} aria-label="Period">
          {LISTING_ACTIVITY_DAYS.map((d) => (
            <Link key={d} href={href(d)} className={d === days ? styles.btn : styles.btnGhost} aria-current={d === days ? 'page' : undefined}>{d} days</Link>
          ))}
        </nav>
      </div>

      <div className={styles.statsWide}>
        <div className={styles.stat}><span className={styles.statNum}>{data.totals.views}</span><span className={styles.statLabel}>Views</span></div>
        <div className={styles.stat}><span className={styles.statNum}>{data.totals.people}</span><span className={styles.statLabel}>Signed-in people</span></div>
        <div className={styles.stat}><span className={styles.statNum}>{data.totals.anonymousViews}</span><span className={styles.statLabel}>Anonymous views</span></div>
        <div className={styles.stat}><span className={styles.statNum}>{data.totals.searches}</span><span className={styles.statLabel}>Searches in these suburbs</span></div>
      </div>

      <section className={styles.card} aria-label="By listing">
        {data.listings.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No views in the last {days} days</p>
            <p className={styles.emptyHint}>Views are counted from the public site, and your own team’s are left out.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className={styles.table}>
              <thead><tr><th>Listing</th><th>Views</th><th>Signed-in people</th><th>Saves</th><th>Enquiries</th></tr></thead>
              <tbody>
                {data.listings.map((l) => (
                  <tr key={l.listingId}><td>{l.address}</td><td>{l.views}</td><td>{l.people}</td><td>{l.saves}</td><td>{l.enquiries}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.card} aria-label="Who">
        {data.people.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Nobody signed in yet</p>
            <p className={styles.emptyHint}>People who are signed in on the site appear here by name.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className={styles.table}>
              <thead><tr><th>Who</th><th>Did</th><th>When</th><th /></tr></thead>
              <tbody>
                {data.people.map((p, i) => (
                  <tr key={`${p.userId}-${p.at.toISOString()}-${i}`}>
                    <td>{p.name}<div className={styles.sub}>{p.email}</div></td>
                    <td><span className={styles.chip}>{DID[p.kind]}</span> {p.what}</td>
                    <td><LocalTime iso={p.at.toISOString()} style="short" /></td>
                    <td>
                      {p.contactId
                        ? <Link href={`${contactBase}/${p.contactId}`} className={styles.back}>Profile →</Link>
                        : <span className={styles.chipInferred}>Not a customer yet</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {pages > 1 ? (
        <div className={styles.inlineFields}>
          {pageNo > 1 ? <Link href={href(days, pageNo - 1)} className={styles.back}>← Newer</Link> : null}
          <span className={styles.muted}>Page {pageNo} of {pages}</span>
          {pageNo < pages ? <Link href={href(days, pageNo + 1)} className={styles.back}>Older →</Link> : null}
        </div>
      ) : null}
    </div>
  );
}
