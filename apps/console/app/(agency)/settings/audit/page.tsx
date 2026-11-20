import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { agency } from '@repo/db/schema';
import { auditSentence, listAuditLog } from '@repo/core/audit';
import { can } from '@repo/core/permissions';
import contactStyles from '@/components/contacts/contacts.module.css';
import { getConsoleDb } from '../../../../lib/db';
import { requireConsoleAccess } from '../../../../lib/require-console-access';

export const metadata: Metadata = { title: 'Audit log' };

/**
 * The agency's audit log (PLATFORM-PLAN 1.20): who removed, restored or edited a member, sent or withdrew an invite,
 * deleted a listing, and when sends were paused or resumed. Owners and admins (can('audit:read')); newest 200.
 */
export default async function AuditLogPage() {
  const { actor } = await requireConsoleAccess('agency');
  if (!actor.agencyId || !can(actor, 'audit:read', { type: 'audit', agencyId: actor.agencyId })) redirect('/settings');
  const db = getConsoleDb();
  const [rows, [place]] = await Promise.all([
    listAuditLog(db, actor, { limit: 200 }),
    db.select({ timeZone: agency.timeZone }).from(agency).where(eq(agency.id, actor.agencyId)).limit(1),
  ]);
  const when = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: place?.timeZone ?? 'Australia/Sydney' });

  return (
    <div className={contactStyles.wrap}>
      <div className={contactStyles.headText}>
        <h1 className={contactStyles.title}>Audit log</h1>
        <p className={contactStyles.sub}>Changes to your team, invites, deleted listings and paused sends, newest first. Kept for the life of the agency.</p>
      </div>
      <div className={contactStyles.card}>
        {rows.length === 0 ? (
          <p className={`${contactStyles.empty} ${contactStyles.muted}`}>Nothing recorded yet.</p>
        ) : (
          <table className={contactStyles.table}>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <time dateTime={r.createdAt.toISOString()}>{when.format(r.createdAt)}</time>
                  </td>
                  <td>{r.actorName ?? (r.actorUserId ? 'A former member' : 'Automatic')}</td>
                  <td>{auditSentence(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
