import Link from 'next/link';
import { listAgencies, type AgencyStatus } from '@repo/core/platform';
import { AgencyTable } from '@/components/admin/tables';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformAdmin } from '@/lib/require-platform-admin';

const PAGE = 50;
const STATUSES: AgencyStatus[] = ['active', 'trial', 'suspended'];

/** Every agency on the platform, newest first. Search and the status filter live in the URL. */
export default async function AgenciesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { admin } = await requirePlatformAdmin();
  await recordPlatformView(admin, 'agencies');
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const q = one(sp.q)?.trim() ?? '';
  const rawStatus = one(sp.status);
  const status = STATUSES.includes(rawStatus as AgencyStatus) ? (rawStatus as AgencyStatus) : undefined;
  const pageNo = Math.max(1, Number(one(sp.page)) || 1);
  const { rows, total } = await listAgencies(getConsoleDb(), admin, {
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
    limit: PAGE,
    offset: (pageNo - 1) * PAGE,
  });
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const href = (p: number) => `/agencies?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), page: String(p) })}`;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Agencies</h1>
          <p className={styles.sub}>{total} {total === 1 ? 'agency' : 'agencies'}{q || status ? ' match' : ' on the platform'}. Open one to see everything in it.</p>
        </div>
        <form method="get" action="/agencies" className={styles.filters}>
          <input className={styles.input} type="search" name="q" defaultValue={q} placeholder="Agency name" aria-label="Search agencies" />
          <select className={styles.select} name="status" defaultValue={status ?? ''} aria-label="Status">
            <option value="">Any status</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="submit" className={styles.btn}>Search</button>
        </form>
      </div>
      <section className={styles.card}>
        <AgencyTable rows={rows} />
      </section>
      {pages > 1 ? (
        <div className={styles.filters}>
          {pageNo > 1 ? <Link className={styles.btn} href={href(pageNo - 1)}>← Newer</Link> : null}
          <span className={styles.muted}>Page {pageNo} of {pages}</span>
          {pageNo < pages ? <Link className={styles.btn} href={href(pageNo + 1)}>Older →</Link> : null}
        </div>
      ) : null}
    </div>
  );
}
