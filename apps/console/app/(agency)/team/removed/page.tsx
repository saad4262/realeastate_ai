import Link from 'next/link';
import { listRemovedMembers, RESTORE_DAYS } from '@repo/core/team';
import { RestoreButton } from '@/components/offboarding/restore-button';
import { getConsoleDb } from '../../../../lib/db';
import { requireConsoleAccess } from '../../../../lib/require-console-access';

/** People removed from the agency, with Undo for 30 days (docs/adr/0030 §8). */
export default async function Page() {
  const session = await requireConsoleAccess('agency');
  const removed = await listRemovedMembers(getConsoleDb(), session.actor);
  return (
    <div style={{ padding: '1.5rem', maxWidth: '48rem' }}>
      <h1 style={{ margin: 0, font: '700 1.375rem/1.2 var(--font-display)' }}>Removed members</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        A removal can be undone for {RESTORE_DAYS} days. <Link href="/team">Back to the team</Link>
      </p>
      {removed.length ? (
        <ul style={{ display: 'grid', gap: '0.5rem', padding: 0, listStyle: 'none' }}>
          {removed.map((r) => (
            <li key={r.userId} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              <span style={{ flex: 1 }}>
                <strong>{r.name}</strong> — removed {r.removedAt.toLocaleDateString('en-AU')}
              </span>
              {r.mayRestore ? <RestoreButton userId={r.userId} name={r.name} /> : <span style={{ color: 'var(--text-secondary)' }}>Undo no longer available</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p>Nobody has been removed.</p>
      )}
    </div>
  );
}
