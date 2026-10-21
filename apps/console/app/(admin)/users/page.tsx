import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { listSiteUsers } from '@repo/core/platform';
import styles from '@/components/admin/admin.module.css';
import { getConsoleDb } from '@/lib/db';
import { recordPlatformView, requirePlatformAdmin } from '@/lib/require-platform-admin';

const PAGE = 50;

/** Everyone with a public-site account (no agency membership), most recently active first. */
export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { admin } = await requirePlatformAdmin();
  await recordPlatformView(admin, 'users');
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const q = one(sp.q)?.trim() ?? '';
  const pageNo = Math.max(1, Number(one(sp.page)) || 1);
  const { rows, total } = await listSiteUsers(getConsoleDb(), admin, { ...(q ? { q } : {}), limit: PAGE, offset: (pageNo - 1) * PAGE });
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const href = (p: number) => `/users?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Users</h1>
          <p className={styles.sub}>
            {total} {total === 1 ? 'person' : 'people'} with an account on the public site{q ? ' match' : ''}. Open one to see what they
            search for, open, save and ask.
          </p>
        </div>
        <form method="get" action="/users" className={styles.filters}>
          <input className={styles.input} type="search" name="q" defaultValue={q} placeholder="Name or email" aria-label="Search users" />
          <button type="submit" className={styles.btn}>Search</button>
        </form>
      </div>
      <section className={styles.card}>
        {rows.length === 0 ? (
          <p className={styles.empty}>No users{q ? ' match that search' : ' yet'}.</p>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>User</th>
                  <th className={styles.num}>Searches</th>
                  <th className={styles.num}>Views</th>
                  <th className={styles.num}>Enquiries</th>
                  <th className={styles.num}>Saved searches</th>
                  <th className={styles.num}>Shortlist</th>
                  <th className={styles.num}>Guide chats</th>
                  <th>Last active</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link className={styles.name} href={`/users/${u.id}`}>{u.name}</Link>
                      <div className={styles.muted}>{u.email}</div>
                    </td>
                    <td data-label="Searches" className={styles.num}>{u.searches}</td>
                    <td data-label="Views" className={styles.num}>{u.views}</td>
                    <td data-label="Enquiries" className={styles.num}>{u.enquiries}</td>
                    <td data-label="Saved searches" className={styles.num}>{u.savedSearches}</td>
                    <td data-label="Shortlist" className={styles.num}>{u.shortlist}</td>
                    <td data-label="Guide chats" className={styles.num}>{u.chats}</td>
                    <td data-label="Last active">{u.lastActiveAt ? <LocalTime iso={u.lastActiveAt.toISOString()} /> : <span className={styles.muted}>—</span>}</td>
                    <td data-label="Joined"><LocalTime iso={u.createdAt.toISOString()} style="date" /></td>
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
