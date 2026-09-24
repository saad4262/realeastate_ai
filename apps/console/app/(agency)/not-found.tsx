import Link from 'next/link';
import styles from '@/components/failure.module.css';

/**
 * Reached when notFound() fires inside the agency console — in practice, a
 * listing id that belongs to another agency or no longer exists.
 *
 * getListingForEdit scopes by agency and returns null rather than throwing a
 * permission error, so another agency's listing is deliberately indistinguish-
 * able from one that was never there. This page must not undo that by hinting
 * the record exists.
 */
export default function AgencyNotFound() {
  return (
    <div className={styles.wrap}>
      <span className={styles.icon} aria-hidden>
        search_off
      </span>
      <h1 className={styles.title}>Not found</h1>
      <p className={styles.body}>
        This listing isn’t in your agency’s book. It may have been deleted, or the link
        may be wrong.
      </p>
      <div className={styles.actions}>
        <Link href="/live-listings" className={styles.primary}>
          Back to listings
        </Link>
      </div>
    </div>
  );
}
