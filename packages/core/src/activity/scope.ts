import { sql, type SQL } from 'drizzle-orm';
import { can, type Actor } from '../permissions';
import { PUBLIC_STATUS } from '../listings/search-listings';

/**
 * ADR 0083: which public-site activity an agency may see, the ONE rule. Its own listings; for somebody without
 * `listing:read_all`, the listings they are named on. A search names a place and not a listing, so it counts where
 * one of those listings is live in that suburb. Fragments over `a` (site_activity).
 */

const NO_AGENCY = '00000000-0000-0000-0000-000000000000';

/** `select id` of the listings whose activity this actor may see. */
export function activityListingIdsSql(actor: Actor): SQL {
  const agencyId = actor.agencyId ?? NO_AGENCY;
  if (can(actor, 'listing:read_all', { type: 'listing', agencyId })) {
    return sql`select li.id from listing li where li.agency_id = ${agencyId}`;
  }
  return sql`select la.listing_id from listing_agent la join listing li on li.id = la.listing_id where la.user_id = ${actor.userId} and li.agency_id = ${agencyId}`;
}

/** A row of `a` that is a view of one of those listings. */
export function viewInScopeSql(actor: Actor): SQL {
  return sql`a.kind = 'listing_view' and a.agency_id = ${actor.agencyId ?? NO_AGENCY} and a.listing_id in (${activityListingIdsSql(actor)})`;
}

/** A row of `a` that is a search in a suburb where one of those listings is live. */
export function searchInScopeSql(actor: Actor): SQL {
  return sql`a.kind = 'search' and a.suburb is not null and exists (
    select 1 from listing sl join property sp on sp.id = sl.property_id
    where sl.status = ${PUBLIC_STATUS} and sl.id in (${activityListingIdsSql(actor)})
      and lower(sp.suburb) = lower(a.suburb) and (a.state is null or upper(sp.state) = upper(a.state))
  )`;
}

const CHANNEL: Record<string, string> = { sale: 'buy', rent: 'rent', sold: 'sold', leased: 'leased' };

/** A search's filters in words. Figures only as the person typed them. Pure. */
export function searchWords(query: Record<string, unknown> | null, place?: { suburb?: string | null; state?: string | null; channel?: string | null }): string {
  const parts: string[] = [];
  if (place?.suburb) parts.push([place.suburb, place.state].filter(Boolean).join(' '));
  if (place?.channel) parts.push(CHANNEL[place.channel] ?? place.channel);
  const q = query ?? {};
  if (q.bedrooms) parts.push(`${q.bedrooms}+ bed`);
  if (q.bathrooms) parts.push(`${q.bathrooms}+ bath`);
  if (q.propertyType) parts.push(String(q.propertyType));
  if (q.priceFrom || q.priceTo) parts.push(`$${Number(q.priceFrom ?? 0).toLocaleString('en-AU')}–${q.priceTo ? `$${Number(q.priceTo).toLocaleString('en-AU')}` : 'any'}`);
  if (q.radiusKm) parts.push(`within ${q.radiusKm} km`);
  if (q.text) parts.push(`“${String(q.text)}”`);
  return parts.join(' · ');
}

/** "1/14 Henry St, Paddington" from a property row aliased `p`. Null when there is none. */
export const PROPERTY_ADDRESS = sql.raw(
  `nullif(trim(both ' ,' from concat_ws(' ', case when p.unit is not null and p.unit <> '' then p.unit || '/' || coalesce(p.street_number, '') else p.street_number end, p.street) || ', ' || p.suburb), '')`,
);
