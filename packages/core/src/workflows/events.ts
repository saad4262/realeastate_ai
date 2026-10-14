import { workflowEvent, type Db, type DbOrTx } from '@repo/db';
import type { Actor } from '../permissions';
import type { TriggerKind } from './catalog';

/**
 * The transactional outbox of ADR 0041: the core function that makes a trigger's change writes one
 * event row with the SAME handle, inside its own transaction — a rolled-back change emits nothing,
 * and a committed one is never missed. Ids and the trigger's facts only; never text.
 *
 * Who caused it decides the origin: a workflow's own step (`actor.via`) never triggers another
 * workflow; the public website has no actor.
 */
export type WorkflowEventInput = {
  agencyId: string;
  kind: TriggerKind;
  leadId?: string | null;
  contactId?: string | null;
  listingId?: string | null;
  appointmentId?: string | null;
  actor?: Actor | null;
  data?: Record<string, string | number>;
};

export function originOf(actor: Actor | null | undefined): 'person' | 'website' | 'workflow' {
  if (!actor) return 'website';
  return actor.via === 'workflow' ? 'workflow' : 'person';
}

export async function emitWorkflowEvent(tx: DbOrTx, e: WorkflowEventInput): Promise<void> {
  await tx.insert(workflowEvent).values({
    agencyId: e.agencyId,
    kind: e.kind,
    leadId: e.leadId ?? null,
    contactId: e.contactId ?? null,
    listingId: e.listingId ?? null,
    appointmentId: e.appointmentId ?? null,
    actorId: e.actor?.userId ?? null,
    origin: originOf(e.actor),
    data: e.data ?? {},
  });
}

/**
 * A change and its event in one transaction — a savepoint when the caller already holds one. For the
 * functions whose change is a single statement and so had no transaction of their own.
 */
export function atomically<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  return (db as Db).transaction((tx) => fn(tx as unknown as DbOrTx));
}
