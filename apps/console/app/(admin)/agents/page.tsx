import Link from 'next/link';
import { listAllPeople } from '@repo/core/platform';
import { PeopleTable } from '@/components/admin/tables';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformAdmin } from '@/lib/require-platform-admin';

const PAGE = 50;

/** Every member of every agency. Open one to see what they see, inside their agency. */
export default async function AllAgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { admin } = await requirePlatformAdmin();
  await recordPlatformView(admin, 'all_agents');
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const q = one(sp.q)?.trim() ?? '';
  const pageNo = Math.max(1, Number(one(sp.page)) || 1);
  const { rows, total } = await listAllPeople(getConsoleDb(), admin, { ...(q ? { q } : {}), limit: PAGE, offset: (pageNo - 1) * PAGE });
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const href = (p: number) => `/agents?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Agents</h1>
          <p className={styles.sub}>{total} {total === 1 ? 'person' : 'people'} across every agency{q ? ' match' : ''}.</p>
        </div>
        <form method="get" action="/agents" className={styles.filters}>
          <input className={styles.input} type="search" name="q" defaultValue={q} placeholder="Name, email or agency" aria-label="Search agents" />
          <button type="submit" className={styles.btn}>Search</button>
        </form>
      </div>
      <section className={styles.card}>
        <PeopleTable rows={rows} showAgency />
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
