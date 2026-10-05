import { sql, type SQL } from 'drizzle-orm';
import { can, type Actor, type Resource } from '../permissions';

/**
 * Who may see which contact — the SQL half of `contact:read` (ADR 0018).
 *
 * The rule itself lives in `can()`. A list cannot ask can() row by row without
 * loading the whole book, so the list's WHERE says the same thing in SQL, here,
 * once — used by the directory, the inbox and the header counts. The smoke
 * check "contact visibility: can() and SQL agree" compares the two for every
 * member and contact in the database, so changing the client's rule means
 * changing `can()` and this file, and the check goes red if only one moved.
 *
 * A member who is not an admin sees a contact that is:
 *   - assigned to them, or
 *   - behind a NON-OFFER lead assigned to them or come through a listing they
 *     are named on (exactly the leads `lead:read` lets them open), or
 *   - tied by `contact_property` to an address where their agency has a
 *     listing they are named on.
 * Offers never make a contact visible: `lead:read_offer` is admin-only.
 */

/** `select id from contact …` — the live contacts this actor may see. */
export function visibleContactIdsSql(actor: Actor): SQL {
  const agencyId = actor.agencyId ?? '00000000-0000-0000-0000-000000000000';
  if (can(actor, 'contact:read_all', { type: 'contact', agencyId })) {
    return sql`select c.id from contact c where c.agency_id = ${agencyId} and c.merged_into_id is null`;
  }
  return narrowedContactIdsSql(actor.userId, sql`${agencyId}`);
}

/**
 * The non-admin half on its own, with the agency as an SQL expression — for a
 * query that only learns the agency in the same statement (the console
 * header's unread count). The caller decides with can() whether to use it.
 */
export function narrowedContactIdsSql(userId: string, agencyExpr: SQL): SQL {
  const me = userId;
  const live = sql`c.agency_id = ${agencyExpr} and c.merged_into_id is null`;
  return sql`select c.id from contact c where ${live} and (
    c.assigned_to = ${me}
    or exists (
      select 1 from lead l
      where l.contact_id = c.id and l.kind <> 'offer'
        and (l.assigned_to = ${me}
          or exists (select 1 from listing_agent la
                     where la.listing_id = l.listing_id and la.user_id = ${me}))
    )
    or exists (
      select 1 from contact_property cp
      join listing li on li.property_id = cp.property_id and li.agency_id = c.agency_id
      join listing_agent la on la.listing_id = li.id and la.user_id = ${me}
      where cp.contact_id = c.id
    )
  )`;
}

/** The facts `can()` needs about one contact. */
export type ContactAccessFacts = {
  id: string;
  agencyId: string;
  assignedTo: string | null;
  leadAssigneeIds: string[];
  listingAgentIds: string[];
};

/**
 * Columns that load those facts in the same statement as the contact, given
 * expressions for its id and agency. Sub-selects, so the caller's query count
 * does not change.
 */
export function contactAccessColumns(idExpr: SQL | unknown, agencyExpr: SQL | unknown) {
  return {
    leadAssigneeIds: sql<string[] | string | null>`(
      select array_agg(distinct l.assigned_to) from lead l
      where l.contact_id = ${idExpr} and l.kind <> 'offer' and l.assigned_to is not null
    )`,
    listingAgentIds: sql<string[] | string | null>`(
      select array_agg(distinct la.user_id) from listing_agent la
      where la.listing_id in (
        select l.listing_id from lead l
        where l.contact_id = ${idExpr} and l.kind <> 'offer' and l.listing_id is not null
        union
        select li.id from contact_property cp
        join listing li on li.property_id = cp.property_id and li.agency_id = ${agencyExpr}
        where cp.contact_id = ${idExpr}
      )
    )`,
  };
}

/** A uuid[] may arrive as an array or, through some paths, as `{a,b}` text. */
export function idArray(value: string[] | string | null | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return value
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter((s) => s && s !== 'NULL');
}

export function contactResource(c: ContactAccessFacts): Resource {
  return {
    type: 'contact',
    id: c.id,
    agencyId: c.agencyId,
    ...(c.assignedTo ? { ownerId: c.assignedTo } : {}),
    leadAssigneeIds: c.leadAssigneeIds,
    listingAgentIds: c.listingAgentIds,
  };
}

export function mayReadContact(actor: Actor, c: ContactAccessFacts): boolean {
  return can(actor, 'contact:read', contactResource(c));
}
