import { desc, eq, getTableColumns } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { auditLog, user, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';

/**
 * The agency's audit log (PLATFORM-PLAN 1.20). Callers write inside the transaction that makes the change, so
 * a change and its record land together or not at all. `detail` holds field names and ids, never personal values.
 */
export type AuditAction = 'member_removed' | 'member_restored' | 'member_edited' | 'invite_sent' | 'invite_withdrawn' | 'invite_claimed' | 'listing_deleted' | 'sends_paused' | 'sends_resumed' | 'agency_closed' | 'data_exported';

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

/** A row with the names of who did it and to whom (our own `user` mirror; null when the person was deleted). */
export type AuditRow = typeof auditLog.$inferSelect & { actorName: string | null; subjectName: string | null };

const actorUser = alias(user, 'audit_actor');
const subjectUser = alias(user, 'audit_subject');

/** The actor's own agency's log, newest first. Owners and admins only; anyone else gets nothing. One query. */
export async function listAuditLog(db: DbOrTx, actor: Actor, opts: { limit?: number } = {}): Promise<AuditRow[]> {
  const agencyId = actor.agencyId;
  if (!agencyId || !can(actor, 'audit:read', { type: 'audit', agencyId })) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return db
    .select({ ...getTableColumns(auditLog), actorName: actorUser.name, subjectName: subjectUser.name })
    .from(auditLog)
    .leftJoin(actorUser, eq(actorUser.id, auditLog.actorUserId))
    .leftJoin(subjectUser, eq(subjectUser.id, auditLog.subjectUserId))
    .where(eq(auditLog.agencyId, agencyId))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

const ROLE: Record<string, string> = { owner: 'owner', admin: 'admin', agent: 'agent', assistant: 'assistant', read_only: 'read-only member', property_manager: 'property manager' };

/** What happened, in words, for the audit page. Field names and roles only: `detail` never holds personal values. */
export function auditSentence(r: Pick<AuditRow, 'action' | 'subjectName' | 'detail'>): string {
  const who = r.subjectName ?? 'a former member';
  const d = (r.detail ?? {}) as Record<string, unknown>;
  switch (r.action as AuditAction) {
    case 'member_removed':
      return `Removed ${who}${typeof d.role === 'string' ? ` (${ROLE[d.role] ?? d.role})` : ''} from the agency`;
    case 'member_restored':
      return `Restored ${who} to the agency`;
    case 'member_edited': {
      const fields = Array.isArray(d.fields) ? d.fields.join(', ') : '';
      const role = typeof d.roleTo === 'string' ? `; role now ${ROLE[d.roleTo] ?? d.roleTo}` : '';
      return `Edited ${who}${fields ? ` (${fields})` : ''}${role}`;
    }
    case 'invite_sent':
      return 'Sent an agent invite';
    case 'invite_withdrawn':
      return 'Withdrew an agent invite';
    case 'invite_claimed':
      return `${who} accepted an invite and joined`;
    case 'listing_deleted':
      return `Deleted a listing${typeof d.status === 'string' ? ` (it was ${d.status})` : ''}`;
    case 'sends_paused':
      return `Sends paused automatically${typeof d.reason === 'string' ? `: ${d.reason}` : ''}`;
    case 'sends_resumed':
      return 'Resumed sends';
    case 'agency_closed':
      return 'Closed the agency';
    case 'data_exported': {
      const what = typeof d.dataset === 'string' ? d.dataset : 'data';
      const rows = typeof d.rows === 'number' ? `${d.rows} row${d.rows === 1 ? '' : 's'}` : 'rows not counted';
      return `Downloaded ${what} as CSV (${rows}${d.complete === false ? ', stopped before the end' : ''})`;
    }
    default:
      return r.action;
  }
}
