import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '@repo/db';
import { assignIfUnowned, primaryAgentSql } from './auto-assign';

/**
 * The client's visibility rule (2026-10-07) applied to what already exists, so
 * nothing an agent works on drops out of sight when the listing stops opening
 * it:
 *   1. an unassigned, non-offer lead that came through a listing goes to that
 *      listing's primary agent (role `lead`, first in order, active, not
 *      read-only) — none: it stays in the owners'/admins' queue;
 *   2. its contact goes with it, if the contact is nobody's;
 *   3. a contact that is nobody's and is tied (contact_property) to an address
 *      where the agency has a listing goes to the primary agent of the latest
 *      listing there.
 * Someone else's contact is never touched. `planVisibilityBackfill` only reads;
 * `applyVisibilityBackfill` runs the same plan in one transaction and records
 * each change on the contact's timeline (`via: backfill`).
 */
export type BackfillLead = { leadId: string; agencyId: string; person: string; email: string; address: string; agentId: string; agentName: string };
export type BackfillContact = { contactId: string; agencyId: string; name: string; email: string | null; agentId: string; agentName: string; why: 'their lead' | 'their address' };
export type BackfillPlan = { leads: BackfillLead[]; contacts: BackfillContact[] };

const AGENT_NAME = sql`coalesce((select ap.display_name from agent_profile ap where ap.user_id = u.id), u.name, u.email)`;

export async function planVisibilityBackfill(db: DbOrTx): Promise<BackfillPlan> {
  const leads = await db.execute<BackfillLead>(sql`
    select x.lead_id as "leadId", x.agency_id as "agencyId", x.person, x.email, x.address, x.agent_id as "agentId", ${AGENT_NAME} as "agentName"
    from (
      select l.id as lead_id, l.agency_id, l.name as person, l.email,
             concat_ws(' ', p.unit, p.street_number, p.street, p.suburb) as address,
             ${primaryAgentSql(sql`l.listing_id`)} as agent_id, l.created_at
      from lead l join property p on p.id = l.property_id
      where l.kind <> 'offer' and l.assigned_to is null and l.listing_id is not null
    ) x
    join "user" u on u.id = x.agent_id
    order by x.created_at`);

  // A lead's contact goes with the lead (first), else an address's listing agent.
  const contacts = await db.execute<BackfillContact>(sql`
    with via_lead as (
      select distinct on (c.id) c.id, c.agency_id, ${primaryAgentSql(sql`l.listing_id`)} as agent_id, 'their lead'::text as why
      from contact c join lead l on l.contact_id = c.id
      where c.assigned_to is null and c.merged_into_id is null
        and l.kind <> 'offer' and l.assigned_to is null and l.listing_id is not null
      order by c.id, l.created_at
    ),
    via_address as (
      select distinct on (c.id) c.id, c.agency_id, ${primaryAgentSql(sql`li.id`)} as agent_id, 'their address'::text as why
      from contact c
      join contact_property cp on cp.contact_id = c.id
      join listing li on li.property_id = cp.property_id and li.agency_id = c.agency_id
      where c.assigned_to is null and c.merged_into_id is null
      order by c.id, li.created_at desc
    ),
    chosen as (
      select * from via_lead where agent_id is not null
      union all
      select * from via_address a where a.agent_id is not null and not exists (select 1 from via_lead v where v.id = a.id and v.agent_id is not null)
    )
    select ch.id as "contactId", ch.agency_id as "agencyId", c.name, c.email, ch.agent_id as "agentId", ${AGENT_NAME} as "agentName", ch.why
    from chosen ch join contact c on c.id = ch.id join "user" u on u.id = ch.agent_id
    order by c.name`);

  return { leads: [...leads], contacts: [...contacts] };
}

/** Run the plan, in one transaction; re-checks "still unassigned" in every write. */
export async function applyVisibilityBackfill(db: Db): Promise<{ leads: number; contacts: number }> {
  return db.transaction(async (tx) => {
    const plan = await planVisibilityBackfill(tx);
    let leads = 0;
    for (const l of plan.leads) {
      const done = await tx.execute(sql`update lead set assigned_to = ${l.agentId}, updated_at = now() where id = ${l.leadId} and assigned_to is null returning id`);
      leads += [...done].length;
    }
    let contacts = 0;
    for (const c of plan.contacts) {
      contacts += (await assignIfUnowned(tx, c.agencyId, [c.contactId], c.agentId, 'backfill')).length;
    }
    return { leads, contacts };
  });
}
