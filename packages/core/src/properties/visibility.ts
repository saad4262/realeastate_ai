import { sql, type SQL } from 'drizzle-orm';
import { can, type Actor } from '../permissions';
import { narrowedContactIdsSql } from '../contacts/visibility';
import { visibleDealsSql } from '../deals/deals';

/**
 * Which addresses a person may open, and which of the records on one they see (ADR 0065).
 *
 * Every decision is `can()`'s; this file only says the answer in SQL, over the aliases the property
 * queries use, so a list can be filtered in one statement. The lead half is `leadScopeFilters`' rule
 * (list-leads.ts), the appointment half `appointmentScopeFilters`' (appointments.ts), the contact half
 * `narrowedContactIdsSql` itself and the deal half the pipeline's own `visibleDealsSql`. Aliases are fixed
 * strings from this module, never input.
 */

const NO_AGENCY = '00000000-0000-0000-0000-000000000000';

type LeadAlias = 'l';
type AppointmentAlias = 'a';

function agencyOf(actor: Actor): string {
  return actor.agencyId ?? NO_AGENCY;
}

/** Owners and admins see every address the agency has a record of. */
export function seesAllProperties(actor: Actor): boolean {
  return Boolean(actor.agencyId && actor.membershipRole) && can(actor, 'listing:read_all', { type: 'listing', agencyId: agencyOf(actor) });
}

/** The leads `lead:read` and `lead:read_offer` let this person see, as a WHERE over `l`. */
export function leadVisibleSql(actor: Actor, alias: LeadAlias = 'l'): SQL {
  const a = sql.raw(alias);
  const agencyId = agencyOf(actor);
  const resource = { type: 'lead', agencyId };
  const parts: SQL[] = [sql`${a}.agency_id = ${agencyId}`];
  if (!actor.membershipRole || !can(actor, 'lead:read', resource)) parts.push(sql`false`);
  // An offer is a named person's money on somebody's home: owners and admins only, as everywhere.
  if (!can(actor, 'lead:read_offer', resource)) parts.push(sql`${a}.kind <> 'offer'`);
  if (!can(actor, 'lead:read_all', resource)) {
    parts.push(sql`(${a}.assigned_to = ${actor.userId} or exists (select 1 from listing_agent la where la.listing_id = ${a}.listing_id and la.user_id = ${actor.userId}))`);
  }
  return sql.join(parts, sql` and `);
}

/** The appointments `appointment:read` lets this person see, as a WHERE over `a`. */
export function appointmentVisibleSql(actor: Actor, alias: AppointmentAlias = 'a'): SQL {
  const a = sql.raw(alias);
  const agencyId = agencyOf(actor);
  const parts: SQL[] = [sql`${a}.agency_id = ${agencyId}`];
  if (!actor.membershipRole) parts.push(sql`false`);
  if (!can(actor, 'appointment:read_all', { type: 'appointment', agencyId })) {
    parts.push(sql`(${a}.assigned_agent_id = ${actor.userId} or ${a}.created_by = ${actor.userId}
      or exists (select 1 from appointment_participant ap where ap.appointment_id = ${a}.id and ap.user_id = ${actor.userId}))`);
  }
  return sql.join(parts, sql` and `);
}

/**
 * `select property_id …` — the addresses this person may open (decision 1). Owners and admins: any the
 * agency has a listing, an enquiry, a linked contact, an appointment, a deal or a document at. Anyone else:
 * one they are tied to — a listing they are named on, a lead or appointment they may see, a contact of
 * theirs linked to it, or their deal.
 */
export function visiblePropertyIdsSql(actor: Actor): SQL {
  const agencyId = agencyOf(actor);
  if (!actor.agencyId || !actor.membershipRole) return sql`select null::uuid as property_id where false`;
  const leads = leadVisibleSql(actor);
  const appointments = appointmentVisibleSql(actor);
  if (seesAllProperties(actor)) {
    return sql`
      select li.property_id from listing li where li.agency_id = ${agencyId}
      union select l.property_id from lead l where ${leads}
      union select cp.property_id from contact_property cp join contact c on c.id = cp.contact_id where c.agency_id = ${agencyId} and c.merged_into_id is null
      union select a.property_id from appointment a where a.property_id is not null and ${appointments}
      union select d.property_id from deal d where d.agency_id = ${agencyId}
      union select doc.property_id from document doc where doc.agency_id = ${agencyId} and doc.property_id is not null and doc.deleted_at is null`;
  }
  return sql`
    select li.property_id from listing li join listing_agent la on la.listing_id = li.id and la.user_id = ${actor.userId} where li.agency_id = ${agencyId}
    union select l.property_id from lead l where ${leads}
    union select cp.property_id from contact_property cp where cp.contact_id in (${narrowedContactIdsSql(actor.userId, sql`${agencyId}`)})
    union select a.property_id from appointment a where a.property_id is not null and ${appointments}
    union select d.property_id from deal d where ${visibleDealsSql(actor)}`;
}
