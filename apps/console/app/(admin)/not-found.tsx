import Link from 'next/link';
import styles from '@/components/failure.module.css';

/** An agency, member, thread or contact that is not there (or is not in that agency). */
export default function AdminNotFound() {
  return (
    <div className={styles.wrap}>
      <span className={styles.icon} aria-hidden>
        search_off
      </span>
      <h1 className={styles.title}>Not found</h1>
      <p className={styles.body}>Nothing here — it may have been deleted, or the link may be wrong.</p>
      <div className={styles.actions}>
        <Link href="/agencies" className={styles.primary}>
          Back to agencies
        </Link>
      </div>
    </div>
  );
}
