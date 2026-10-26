import { eq, isNull, sql, type SQL } from 'drizzle-orm';
import { document } from '@repo/db';
import { can, type Actor } from '../permissions';
import { narrowedContactIdsSql } from '../contacts/visibility';

/**
 * Who sees which document — the SQL half of the ADR 0053 §3 rule, written once and used by
 * every list, search, read and download (one rule, so they cannot disagree):
 *
 *   - knowledge base → every member of the agency (`knowledge:read`);
 *   - a record → owners/admins (`document:read_private` with no owner), its uploader, and —
 *     unless it is private — whoever may read its contact (`contact:read`'s SQL half,
 *     `narrowedContactIdsSql`) or is named on its listing (`listing:edit`'s shape).
 *
 * A record on no contact and no listing (mail to the agency's own address) therefore reaches
 * admins and nobody else, like that mail's thread. Always this actor's agency; never deleted.
 */
const NO_AGENCY = '00000000-0000-0000-0000-000000000000';

export function documentScopeFilters(actor: Actor): SQL[] {
  const agencyId = actor.agencyId ?? NO_AGENCY;
  const filters: SQL[] = [eq(document.agencyId, agencyId), isNull(document.deletedAt)];
  if (!can(actor, 'knowledge:read', { type: 'knowledge', agencyId })) return [...filters, sql`false`];
  // Admins: everything in the agency. Asked with no owner, the private rule is "every private document".
  if (can(actor, 'document:read_private', { type: 'document', agencyId })) return filters;
  const me = actor.userId;
  // "document"."…" spelled out: in a one-table select Drizzle renders ${document.listingId} as a
  // bare "listing_id", which inside the listing_agent sub-select would mean la.listing_id — and
  // every agent would see every listing's documents. Queries using this keep `document` unaliased.
  filters.push(sql`(
    "document"."scope" = 'knowledge'
    or "document"."uploaded_by" = ${me}
    or ("document"."is_private" = false and (
      ("document"."contact_id" is not null and "document"."contact_id" in (${narrowedContactIdsSql(me, sql`${agencyId}`)}))
      or ("document"."listing_id" is not null and exists (
        select 1 from listing_agent la where la.listing_id = "document"."listing_id" and la.user_id = ${me}
      ))
    ))
  )`);
  return filters;
}
