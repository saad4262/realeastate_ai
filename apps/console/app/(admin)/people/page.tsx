import Link from 'next/link';
import { listEveryone, parsePersonType, PERSON_TYPE_LABELS, PEOPLE_TYPES, type EveryoneRow } from '@repo/core/platform';
import styles from '@/components/admin/admin.module.css';
import { Stat } from '@/components/admin/tables';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformAdmin } from '@/lib/require-platform-admin';

const PAGE = 50;

function profileHref(r: EveryoneRow): string {
  if (r.type === 'customer') return `/agencies/${r.agencyId}/customers/${r.id}`;
  if (r.type === 'member') return `/agencies/${r.agencyId}/agents/${r.id}`;
  return `/users/${r.id}`;
}

/** Everyone on the platform in one list (ADR 0083): customers, agency staff and website accounts. Read only. */
export default async function PeoplePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { admin } = await requirePlatformAdmin();
  await recordPlatformView(admin, 'people');
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const q = one(sp.q)?.trim() ?? '';
  const type = parsePersonType(one(sp.type));
  const pageNo = Math.max(1, Number(one(sp.page)) || 1);
  const { rows, total, byType } = await listEveryone(getConsoleDb(), admin, { ...(q ? { q } : {}), type, limit: PAGE, offset: (pageNo - 1) * PAGE });
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const href = (p: number) => `/people?${new URLSearchParams({ ...(q ? { q } : {}), ...(type ? { type } : {}), page: String(p) })}`;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>People</h1>
          <p className={styles.sub}>Everyone on the platform, in one list{q ? `, matching “${q}”` : ''}. Read only.</p>
        </div>
        <form method="get" action="/people" className={styles.filters}>
          <input className={styles.input} type="search" name="q" defaultValue={q} placeholder="Name, email, phone or agency" aria-label="Search people" />
          <select className={styles.input} name="type" defaultValue={type ?? ''} aria-label="Type">
            <option value="">Everyone</option>
            {PEOPLE_TYPES.map((t) => <option key={t} value={t}>{PERSON_TYPE_LABELS[t]}</option>)}
          </select>
          <button type="submit" className={styles.btn}>Search</button>
        </form>
      </div>
      <div className={styles.stats}>
        <Stat label="Customers" value={byType.customer} />
        <Stat label="Agency staff" value={byType.member} />
        <Stat label="Website accounts" value={byType.account} />
      </div>
      <section className={styles.card}>
        {rows.length === 0 ? (
          <p className={styles.empty}>Nobody{q ? ' matches that search' : ' yet'}.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr><th>Name</th><th>Type</th><th>Agency</th><th>Email / phone</th><th>Address</th><th className={styles.num}>Leads</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.type}-${r.id}-${r.agencyId ?? ''}`}>
                    <td><Link href={profileHref(r)}>{r.name}</Link></td>
                    <td data-label="Type">{PERSON_TYPE_LABELS[r.type]}</td>
                    <td data-label="Agency">{r.agencyName ?? '—'}</td>
                    <td data-label="Email / phone">{r.email ?? '—'}{r.phone ? <div className={styles.muted}>{r.phone}</div> : null}</td>
                    <td data-label="Address">{r.address ?? '—'}</td>
                    <td data-label="Leads" className={styles.num}>{r.leads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {pages > 1 ? (
        <div className={styles.filters}>
          {pageNo > 1 ? <Link className={styles.btn} href={href(pageNo - 1)}>← Previous</Link> : null}
          <span className={styles.muted}>Page {pageNo} of {pages}</span>
          {pageNo < pages ? <Link className={styles.btn} href={href(pageNo + 1)}>Next →</Link> : null}
        </div>
      ) : null}
    </div>
  );
}
