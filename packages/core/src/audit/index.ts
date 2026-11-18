import { desc, eq } from 'drizzle-orm';
import { auditLog, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';

/**
 * The agency's audit log (PLATFORM-PLAN 1.20). Callers write inside the transaction that makes the change, so
 * a change and its record land together or not at all. `detail` holds field names and ids, never personal values.
 */
export type AuditAction = 'member_removed' | 'member_restored' | 'member_edited' | 'invite_sent' | 'invite_withdrawn' | 'invite_claimed' | 'listing_deleted' | 'sends_paused' | 'sends_resumed';

export type AuditEntry = {
  agencyId: string;
  actorUserId: string | null;
  action: AuditAction;
  subjectUserId?: string | null;
  refId?: string | null;
  detail?: Record<string, unknown>;
};

export async function recordAudit(db: DbOrTx, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    agencyId: e.agencyId,
    actorUserId: e.actorUserId,
    action: e.action,
    subjectUserId: e.subjectUserId ?? null,
    refId: e.refId ?? null,
    detail: e.detail ?? {},
  });
}

export type AuditRow = typeof auditLog.$inferSelect;

/** The actor's own agency's log, newest first. Owners and admins only; anyone else gets nothing. */
export async function listAuditLog(db: DbOrTx, actor: Actor, opts: { limit?: number } = {}): Promise<AuditRow[]> {
  const agencyId = actor.agencyId;
  if (!agencyId || !can(actor, 'audit:read', { type: 'audit', agencyId })) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return db.select().from(auditLog).where(eq(auditLog.agencyId, agencyId)).orderBy(desc(auditLog.createdAt)).limit(limit);
}
