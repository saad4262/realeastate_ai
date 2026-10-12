import { dashboardGapLog, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import type { DatasetId } from './catalog';

/**
 * The dashboard gap log (ADR 0036, decided Q2): one row for a figure somebody
 * asked for that the catalog cannot make — a backlog for the platform team,
 * never an approximation, never shown back to the model. Written as the
 * person, in their own agency; anyone who may use the assistant may note one.
 */
export async function recordDataGap(
  db: DbOrTx,
  actor: Actor,
  input: { request: string; wanted: string; nearestDataset?: DatasetId | null },
): Promise<void> {
  if (!actor.agencyId || !can(actor, 'assistant:use', { type: 'assistant', agencyId: actor.agencyId })) {
    throw new Error('Not allowed to use the assistant');
  }
  await db.insert(dashboardGapLog).values({
    agencyId: actor.agencyId,
    userId: actor.userId,
    request: input.request.slice(0, 300),
    nearestDataset: input.nearestDataset ?? null,
    wanted: input.wanted.slice(0, 200),
  });
}
