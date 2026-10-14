import { and, asc, eq, sql } from 'drizzle-orm';
import { membership, user, type DbOrTx } from '@repo/db';
import type { Actor } from '../permissions';
import { seesWholeTeam } from './datasets';
import type { OpenCell, OpenColumn } from './run';

/**
 * Part G: nobody is dropped. A result with an `agent_id` column is checked against the
 * people this actor's "every agent" means (the active team for an owner/admin; themselves
 * otherwise). Those missing are named back, so the model can LEFT JOIN them in.
 * Read by core as the server, never through the model's query.
 */
export async function missingAgents(db: DbOrTx, actor: Actor, columns: OpenColumn[], rows: OpenCell[][]): Promise<{ id: string; name: string }[]> {
  const at = columns.findIndex((c) => c.name === 'agent_id');
  if (at < 0 || !actor.agencyId) return [];
  const present = new Set(rows.map((r) => r[at]).filter((v): v is string => typeof v === 'string'));
  const team = await db
    .select({ id: user.id, name: sql<string>`coalesce(nullif(${user.name}, ''), ${user.email})` })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(and(eq(membership.agencyId, actor.agencyId), eq(membership.status, 'active'), ...(seesWholeTeam(actor) ? [] : [eq(membership.userId, actor.userId)])))
    .orderBy(asc(user.name));
  return team.filter((p) => !present.has(p.id));
}
