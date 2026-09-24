import Link from 'next/link';
import { AppShell } from '@repo/ui';
import styles from './failure.module.css';

/**
 * A 404 that looks like this site.
 *
 * `/listing/[id]` calls notFound() for anything that is not live — a draft, a
 * withdrawn ad, a bad id — and until now every one of those rendered Next's
 * own unstyled default, outside the app's chrome. A withdrawn listing is a
 * link people will have shared, so this is a page real visitors reach.
 */
export default function NotFound() {
  return (
    <AppShell surface="web">
      <div className={styles.wrap}>
        <h1 className={styles.title}>This page isn’t here</h1>
        <p className={styles.body}>
          The listing may have been sold or withdrawn, or the link may be wrong. The
          search has everything that is currently on the market.
        </p>
        <div className={styles.actions}>
          <Link href="/search" className={styles.primary}>
            Search listings
          </Link>
          <Link href="/" className={styles.secondary}>
            Go home
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
