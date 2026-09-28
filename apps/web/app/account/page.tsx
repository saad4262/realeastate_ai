import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { user as userTable } from '@repo/db';
import { listSchedules } from '@repo/core/schedules';
import { WebShell } from '../../components/web-shell';
import { ensureConsumerAccount } from '../../lib/account';
import { getWebDb } from '../../lib/db';
import { requireWebUser } from '../../lib/session';
import styles from './account.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your account',
  // Nobody else's account is at a guessable URL, but this page names a real
  // person and an address; it has no business in an index either way.
  robots: { index: false, follow: false },
};

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "March 2026". A join date is a month, not a timestamp. */
function monthYear(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The profile page, and the only place the session can be ended.
 *
 * ## Why this is a page and not a dropdown in the header
 *
 * The header sits on every route. A menu there would need client JavaScript
 * in the single most widely rendered component on the site, or a `<details>`
 * panel that cannot close when you click away from it without the same
 * JavaScript. Neither is worth it for a control most people press twice a
 * year, and a page can hold things a menu never could — what the account
 * is, what it owns, and how to leave.
 *
 * ## Where the values come from
 *
 * `public.user`, not the middleware headers. The headers are the session and
 * are right about *who* is asking, which is why `requireWebUser` gates on
 * them; but the name is a profile field that `ensureAppUser` keeps with
 * `coalesce`, and the row is the record. Reading the JWT's copy would show a
 * stale name after any future profile edit and would be a second source of
 * truth for the same field (#8, in spirit).
 */
export default async function AccountPage() {
  // Middleware already redirects an anonymous visitor, so this is a backstop
  // for a matcher gap rather than the gate — see requireWebUser.
  await requireWebUser('/account');
  const session = await ensureConsumerAccount();
  if (!session) return null;

  const db = getWebDb();

  // Two independent reads, started together (§ 5). Both are known-count: one
  // row by primary key, and the caller's own schedules.
  const [[row], schedules] = await Promise.all([
    db
      .select({ email: userTable.email, name: userTable.name, createdAt: userTable.createdAt })
      .from(userTable)
      .where(eq(userTable.id, session.id))
      .limit(1),
    listSchedules(db, { userId: session.id }),
  ]);

  // ensureConsumerAccount just upserted this row, so its absence is a
  // database that changed under us mid-request rather than a missing account.
  if (!row) return null;

  const active = schedules.filter((s) => s.status === 'active').length;
  const initial = (row.name ?? row.email).trim().charAt(0).toUpperCase();

  return (
    <WebShell account={{ signedIn: true }}>
      <main className={styles.page}>
        <header className={styles.head}>
          <span className={styles.avatar} aria-hidden>
            {initial}
          </span>
          <div className={styles.identity}>
            <h1 className={styles.title}>{row.name ?? 'Your account'}</h1>
            <p className={styles.email}>{row.email}</p>
          </div>
        </header>

        <section className={styles.card}>
          <h2 className={styles.cardLabel}>Account</h2>
          <dl className={styles.rows}>
            <div className={styles.row}>
              <dt className={styles.key}>Name</dt>
              {/* No invented placeholder. A name we do not have is said to be
                  missing, and the fix is offered rather than described. */}
              <dd className={styles.value}>{row.name ?? <em className={styles.none}>Not set</em>}</dd>
            </div>
            <div className={styles.row}>
              <dt className={styles.key}>Email</dt>
              <dd className={styles.value}>{row.email}</dd>
            </div>
            <div className={styles.row}>
              <dt className={styles.key}>Member since</dt>
              <dd className={styles.value}>{monthYear(new Date(row.createdAt))}</dd>
            </div>
          </dl>
        </section>

        <section className={styles.card}>
          <h2 className={styles.cardLabel}>Saved searches</h2>
          <p className={styles.body}>
            {schedules.length === 0
              ? 'You have no saved searches yet.'
              : `${schedules.length} saved ${schedules.length === 1 ? 'search' : 'searches'}, ${active} running.`}
          </p>
          <Link href="/alerts" className={styles.secondary}>
            {schedules.length === 0 ? 'Set one up' : 'Manage them'}
          </Link>
        </section>

        <section className={styles.card}>
          <h2 className={styles.cardLabel}>Security</h2>
          <p className={styles.body}>
            Changing your password signs you out of nothing else — this is the only device
            holding this session.
          </p>
          <Link href="/reset" className={styles.secondary}>
            Change password
          </Link>
        </section>

        {/*
          A form, not a link.

          /sign-out is POST only, and deliberately: Next prefetches links in
          the viewport, so a GET version would sign people out for scrolling
          past it. The form has no client JavaScript and works with it off.
        */}
        <form method="post" action="/sign-out" className={styles.signOut}>
          <button type="submit" className={styles.danger}>
            Log out
          </button>
          <span className={styles.signOutNote}>
            You will stay signed in on any other device.
          </span>
        </form>
      </main>
    </WebShell>
  );
}
