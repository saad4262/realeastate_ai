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

/**
 * ADR 0044 C: fan-out. In a result that is one row per agent, an agent named twice means two
 * activities were joined in one FROM and the figures multiplied. Pure: read from the result.
 */
export function agentsNamedTwice(columns: OpenColumn[], rows: OpenCell[][]): string[] {
  const at = columns.findIndex((c) => c.name === 'agent_id');
  if (at < 0) return [];
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const r of rows) {
    const id = r[at];
    if (typeof id !== 'string') continue;
    if (seen.has(id)) twice.add(id);
    seen.add(id);
  }
  if (!twice.size) return [];
  const nameAt = columns.findIndex((c) => c.name === 'name' || c.name === 'agent_name');
  return [...twice].map((id) => {
    const named = nameAt >= 0 ? rows.find((r) => r[at] === id)?.[nameAt] : null;
    return typeof named === 'string' && named ? named : id;
  });
}

export const FAN_OUT_PROBLEM = (names: string[]) =>
  `One row per agent was meant, but ${names.slice(0, 5).join(', ')} ${names.length === 1 ? 'appears' : 'appear'} more than once — two activities were joined in one FROM, so the figures are multiplied. Aggregate each activity per agent in its own CTE, then LEFT JOIN the CTEs onto agents.`;
