import Link from 'next/link';
import { LocalTime } from '@repo/ui';
import { listDeletedContacts, RESTORE_DAYS } from '@repo/core/contacts';
import { getConsoleDb } from '../../lib/db';
import { requireConsoleAccess } from '../../lib/require-console-access';
import { RestoreDeletedButton } from './islands';
import styles from './contacts.module.css';

/**
 * "Recently deleted" (ADR 0025 amendment, 2026-10-09): contacts deleted in the
 * last 7 days that this person may bring back — the agency's for an
 * owner/admin, their own for anyone else (decided in packages/core). After 7
 * days the cron tick deletes them for good.
 */
export async function DeletedContacts({ surface, basePath }: { surface: 'agency' | 'agent'; basePath: string }) {
  const session = await requireConsoleAccess(surface);
  const rows = await listDeletedContacts(getConsoleDb(), session.actor);
  return (
    <div className={styles.wrap}>
      <Link href={basePath} className={styles.back}>
        ← Contacts
      </Link>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Recently deleted</h1>
          <p className={styles.sub}>
            Deleted contacts can be restored, exactly as they were, for {RESTORE_DAYS} days. After that they are deleted for good with their notes,
            timeline and past appointments; their enquiries and email conversations stay in the inbox.
          </p>
        </div>
      </div>
      <div className={styles.card}>
        {rows.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rows.map((r) => (
              <li key={r.id} className={styles.section} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{r.name}</div>
                  <div className={styles.note}>
                    {r.email ? `${r.email} · ` : ''}
                    {r.assigneeName ? `${r.assigneeName}’s · ` : ''}deleted <LocalTime iso={r.deletedAt.toISOString()} style="short" />
                    {r.deletedByName ? ` by ${r.deletedByName}` : ''} · restorable until <LocalTime iso={r.goneAt.toISOString()} style="short" />
                  </div>
                </div>
                <RestoreDeletedButton contactId={r.id} name={r.name} />
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.note} style={{ padding: '1rem' }}>
            Nothing deleted in the last {RESTORE_DAYS} days that you can restore.
          </p>
        )}
      </div>
    </div>
  );
}
