import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';

/**
 * Who a listing's enquiries and tied contacts go to (the client's rule,
 * 2026-10-07): its PRIMARY agent — the `lead` role, first in display order —
 * if they are an active member who may hold work (never read-only). A
 * co-agent never; nobody active → nobody, and the work waits for an owner or
 * admin. An SQL expression, so it is decided in the same statement that uses it.
 */
export function primaryAgentSql(listingIdExpr: SQL | string): SQL {
  // Aliases of its own (pa_*): the caller's query may name its tables `la` or `li`, and a
  // shadowed alias here would match every listing (found by smoke).
  return sql`(
    select pa_la.user_id from listing_agent pa_la
    join listing pa_li on pa_li.id = pa_la.listing_id
    join membership pa_m on pa_m.user_id = pa_la.user_id and pa_m.agency_id = pa_li.agency_id
      and pa_m.status = 'active' and pa_m.role <> 'read_only'
    where pa_la.listing_id = ${listingIdExpr} and pa_la.role = 'lead'
    order by pa_la.display_order, pa_la.user_id
    limit 1
  )`;
}

/** Why a contact was given to someone without a person choosing: shown on its timeline. */
export type AutoAssignVia = 'enquiry' | 'address' | 'listing';

/**
 * Give contacts that are nobody's to `userId`, and say so on each timeline
 * (`contact_assigned`, from nobody, by the system, with `via`). A contact that
 * is already someone's is never touched — that is the rule's whole point.
 * `contactIds` is a list or an SQL `select id …`. Inside the caller's
 * transaction; returns the contacts it assigned.
 */
export async function assignIfUnowned(
  tx: DbOrTx,
  agencyId: string,
  contactIds: string[] | SQL,
  userId: string,
  via: AutoAssignVia,
): Promise<string[]> {
  if (Array.isArray(contactIds) && !contactIds.length) return [];
  const ids = Array.isArray(contactIds)
    ? sql`(${sql.join(
        contactIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql`(${contactIds})`;
  const rows = await tx.execute<{ id: string }>(sql`
    update contact set assigned_to = ${userId}, updated_at = now()
    where agency_id = ${agencyId} and merged_into_id is null and assigned_to is null and id in ${ids}
    returning id`);
  const assigned = [...rows].map((r) => r.id);
  if (assigned.length) {
    await tx.execute(sql`
      insert into activity (agency_id, contact_id, kind, actor_type, actor_id, payload)
      select ${agencyId}, x.id, 'contact_assigned', 'system', null,
             jsonb_build_object('from', null, 'to', ${userId}::text, 'via', ${via}::text)
      from unnest(${sql`array[${sql.join(
        assigned.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`}) as x(id)`);
  }
  return assigned;
}
