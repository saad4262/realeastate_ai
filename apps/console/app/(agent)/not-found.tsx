import Link from 'next/link';
import styles from '@/components/failure.module.css';

/** The agent desk equivalent — same reticence about what exists. */
export default function AgentNotFound() {
  return (
    <div className={styles.wrap}>
      <span className={styles.icon} aria-hidden>
        search_off
      </span>
      <h1 className={styles.title}>Not found</h1>
      <p className={styles.body}>
        This listing isn’t one you’re named on. It may have been deleted, or the link may
        be wrong.
      </p>
      <div className={styles.actions}>
        <Link href="/listings" className={styles.primary}>
          Back to my listings
        </Link>
      </div>
    </div>
  );
}
