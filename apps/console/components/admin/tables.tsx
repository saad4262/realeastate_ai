import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { membershipRolePhrase } from '@repo/core/permissions';
import type { PlatformAgencyRow, PlatformPersonRow } from '@repo/core/platform';
import styles from './admin.module.css';

/** The agencies table — the platform home's and /agencies'. Server-rendered, links only. */
export function AgencyTable({ rows }: { rows: PlatformAgencyRow[] }) {
  if (rows.length === 0) return <p className={styles.empty}>No agencies.</p>;
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Agency</th>
            <th>Owner</th>
            <th>Status</th>
            <th className={styles.num}>Members</th>
            <th className={styles.num}>Live listings</th>
            <th className={styles.num}>Leads (30 d)</th>
            <th className={styles.num}>Customers</th>
            <th>Joined</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>
                <Link className={styles.name} href={`/agencies/${a.id}`}>{a.name}</Link>
                <div className={styles.muted}>{a.slug}</div>
              </td>
              <td data-label="Owner">{a.owner ? <>{a.owner.name}<div className={styles.muted}>{a.owner.email}</div></> : <span className={styles.muted}>—</span>}</td>
              <td data-label="Status"><StatusBadge status={a.status} /></td>
              <td data-label="Members" className={styles.num}>{a.members}</td>
              <td data-label="Live listings" className={styles.num}>{a.liveListings}</td>
              <td data-label="Leads (30 d)" className={styles.num}>{a.leads30d}</td>
              <td data-label="Customers" className={styles.num}>{a.contacts}</td>
              <td data-label="Joined"><LocalTime iso={a.createdAt.toISOString()} style="date" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'active' ? styles.badgeGood : status === 'suspended' ? styles.badgeBad : styles.badgeWarn;
  return <span className={tone}>{status}</span>;
}

/**
 * People — one agency's, or everyone's (`showAgency`). Each row opens that
 * member inside their agency, where the read-only view is theirs.
 */
export function PeopleTable({ rows, showAgency = false }: { rows: PlatformPersonRow[]; showAgency?: boolean }) {
  if (rows.length === 0) return <p className={styles.empty}>Nobody yet.</p>;
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Name</th>
            {showAgency ? <th>Agency</th> : null}
            <th>Role</th>
            <th className={styles.num}>Open leads</th>
            <th className={styles.num}>Listings</th>
            <th className={styles.num}>Customers</th>
            <th className={styles.num}>Upcoming meetings</th>
            <th>Last used assistant</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={`${p.agencyId}-${p.userId}`}>
              <td>
                <Link className={styles.name} href={`/agencies/${p.agencyId}/agents/${p.userId}`}>{p.name}</Link>
                <div className={styles.muted}>{p.email}{p.phone ? ` · ${p.phone}` : ''}</div>
              </td>
              {showAgency ? (
                <td data-label="Agency"><Link href={`/agencies/${p.agencyId}`}>{p.agencyName}</Link></td>
              ) : null}
              <td data-label="Role">
                {membershipRolePhrase(p.role).replace(/^(the|an?) /, '')}
                {p.status !== 'active' ? (
                  <>
                    {' '}
                    <span className={p.status === 'suspended' ? styles.badgeBad : styles.badgeWarn}>
                      {p.status === 'suspended' ? (p.removed ? 'removed' : 'blocked') : p.status}
                    </span>
                  </>
                ) : null}
              </td>
              <td data-label="Open leads" className={styles.num}>{p.openLeads}</td>
              <td data-label="Listings" className={styles.num}>{p.listings}</td>
              <td data-label="Customers" className={styles.num}>{p.contacts}</td>
              <td data-label="Upcoming meetings" className={styles.num}>{p.upcomingMeetings}</td>
              <td data-label="Last used assistant">
                {p.lastAssistantAt ? <LocalTime iso={p.lastAssistantAt.toISOString()} /> : <span className={styles.muted}>Never</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One figure on an admin page. Every one is counted by SQL. */
export function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value.toLocaleString('en-AU')}</span>
    </div>
  );
}

/**
 * A ranked list with a bar per row (ADR 0051) — one measure, one hue, scaled to the largest.
 * The number is printed beside every bar, so the list is its own table view.
 */
export function BarList({
  rows,
  empty,
}: {
  rows: { key: string; label: React.ReactNode; title: string; value: number; detail?: string }[];
  empty: string;
}) {
  if (rows.length === 0) return <p className={styles.empty}>{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ol className={styles.bars}>
      {rows.map((r) => (
        <li key={r.key} className={styles.barRow} title={`${r.title}: ${r.detail ?? r.value}`}>
          <span className={styles.barLabel}>{r.label}</span>
          <span className={styles.barValue}>{r.detail ?? r.value.toLocaleString('en-AU')}</span>
          <span className={styles.barTrack} aria-hidden>
            <span className={styles.barFill} style={{ display: 'block', width: `${(r.value / max) * 100}%` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Columns for a short time series (the admin home's leads per week). One measure, one hue; the
 * latest and the highest column carry their number, every column says its own on hover, and a
 * visually hidden table carries all of them for a screen reader.
 */
export function ColumnChart({ points, label }: { points: { key: string; tick: string; title: string; value: number }[]; label: string }) {
  const max = Math.max(...points.map((p) => p.value), 1);
  const peak = points.reduce((best, p, i) => (p.value > (points[best]?.value ?? -1) ? i : best), 0);
  return (
    <figure style={{ margin: 0 }}>
      <div className={styles.columns} aria-hidden>
        {points.map((p, i) => (
          <div key={p.key} className={styles.column} title={`${p.title}: ${p.value}`}>
            {i === points.length - 1 || (i === peak && p.value > 0) ? (
              <span className={styles.columnValue} style={{ bottom: `calc(${(p.value / max) * 100}% + 2px)` }}>{p.value}</span>
            ) : null}
            <div className={styles.columnFill} style={{ height: `${(p.value / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className={styles.columnAxis} aria-hidden>
        {points.map((p, i) => (
          <span key={p.key}>{i % 2 === (points.length - 1) % 2 ? p.tick : ''}</span>
        ))}
      </div>
      <table className={styles.srOnly}>
        <caption>{label}</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}><th scope="row">{p.title}</th><td>{p.value}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
