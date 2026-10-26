import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import { describeRequirement, type RequirementChannel } from '../contacts/contact-schema';
import { SUSPENDED_AGENCY_IDS } from '../platform/access';

/**
 * The opportunity detectors (ADR 0054 §1) — SQL and nothing else (non-negotiable 4). Each looks
 * across every agency at once (the hourly scan), returns at most DETECTOR_LIMIT rows, and names
 * one recipient per row: the person whose work it is (§2). A row's `dedupeKey` carries what makes
 * it new, so running a detector twice finds nothing twice.
 *
 * Every detector skips suspended agencies, merged and archived contacts, and recipients who are
 * not an active member of that agency today.
 */

export const OPPORTUNITY_KINDS = ['sale_anniversary', 'cold_contact', 'unanswered_mail', 'appraisal_follow_up', 'repeat_interest', 'buyer_match'] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

/** The thresholds (v1: constants, not settings). */
export const RULES = {
  anniversaryYears: [5, 10],
  /** Shown for this many days after the anniversary. */
  anniversaryWindowDays: 30,
  coldAfterDays: 90,
  unansweredAfterHours: 48,
  unansweredWithinDays: 21,
  appraisalAfterDays: 3,
  appraisalWithinDays: 30,
  repeatEnquiries: 3,
  repeatWithinDays: 30,
  /** A listing first live within this many days is "new" to a buyer's brief (ADR 0055 §6). */
  buyerMatchWithinDays: 7,
} as const;

/** Per detector per scan, across every agency. */
export const DETECTOR_LIMIT = 500;

export type Detected = {
  kind: OpportunityKind;
  agencyId: string;
  userId: string;
  contactId: string | null;
  listingId: string | null;
  leadId: string | null;
  threadId: string | null;
  appointmentId: string | null;
  dedupeKey: string;
  /** Figures and dates exactly as SQL returned them. */
  facts: Record<string, string | number | null>;
};

/** `userExpr` is an active member of `agencyExpr`, and that agency is not suspended. */
function recipientOk(userExpr: SQL, agencyExpr: SQL): SQL {
  return sql`${agencyExpr} not in ${SUSPENDED_AGENCY_IDS} and exists (
    select 1 from membership mem
    where mem.user_id = ${userExpr} and mem.agency_id = ${agencyExpr} and mem.status = 'active' and mem.removed_at is null
  )`;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

/** A sold listing's owner or vendor, 5 or 10 years on — a natural time to talk about selling again. */
export async function detectSaleAnniversaries(db: DbOrTx): Promise<Detected[]> {
  const rows = await db.execute<{
    agency_id: string; user_id: string; contact_id: string; contact_name: string; listing_id: string; relation: string;
    years: number; sold_date: string; sold_price: string | null; address: string;
  }>(sql`
    select li.agency_id, coalesce(c.assigned_to, la.user_id) as user_id, c.id as contact_id, c.name as contact_name,
      li.id as listing_id, cp.relation::text as relation, y.years, li.sold_date, li.sold_price::text as sold_price,
      concat_ws(', ', nullif(trim(concat(case when p.unit is not null then p.unit || '/' end, concat_ws(' ', p.street_number, p.street))), ''), p.suburb) as address
    from listing li
    join property p on p.id = li.property_id
    join contact_property cp on cp.property_id = li.property_id and cp.relation::text in ('owner', 'vendor')
    join contact c on c.id = cp.contact_id and c.agency_id = li.agency_id
    left join listing_agent la on la.listing_id = li.id and la.display_order = 0
    cross join unnest(${sql.raw(`array[${RULES.anniversaryYears.join(',')}]`)}::int[]) as y(years)
    where li.status = 'sold' and li.sold_date is not null
      and li.sold_date <= now() - make_interval(years => y.years)
      and li.sold_date > now() - make_interval(years => y.years) - make_interval(days => ${RULES.anniversaryWindowDays})
      and c.archived_at is null and c.merged_into_id is null
      and coalesce(c.assigned_to, la.user_id) is not null
      and ${recipientOk(sql`coalesce(c.assigned_to, la.user_id)`, sql`li.agency_id`)}
    order by li.sold_date desc
    limit ${DETECTOR_LIMIT}`);
  return rows.map((r) => ({
    kind: 'sale_anniversary',
    agencyId: r.agency_id,
    userId: r.user_id,
    contactId: r.contact_id,
    listingId: r.listing_id,
    leadId: null,
    threadId: null,
    appointmentId: null,
    dedupeKey: `sale_anniversary:${r.contact_id}:${r.listing_id}:${r.years}`,
    facts: { contactName: r.contact_name, years: Number(r.years), soldDate: iso(r.sold_date), soldPrice: r.sold_price, address: r.address, relation: r.relation },
  }));
}

/** The last time anything happened with a contact, as one SQL expression over `c`. */
const LAST_TOUCH = sql`greatest(
  c.created_at,
  (select max(a.created_at) from activity a where a.contact_id = c.id),
  (select max(n.created_at) from note n where n.contact_id = c.id and n.deleted_at is null),
  (select max(m.created_at) from mail_message m join mail_thread t on t.id = m.thread_id where t.contact_id = c.id),
  (select max(l.created_at) from lead l where l.contact_id = c.id),
  (select max(ap.starts_at) from appointment ap where ap.contact_id = c.id and ap.starts_at <= now())
)`;

/** An assigned client (a lead or a role) with nothing at all for 90 days. */
export async function detectColdContacts(db: DbOrTx): Promise<Detected[]> {
  const rows = await db.execute<{ agency_id: string; user_id: string; contact_id: string; contact_name: string; last_touch: string }>(sql`
    select * from (
      select c.agency_id, c.assigned_to as user_id, c.id as contact_id, c.name as contact_name, ${LAST_TOUCH} as last_touch
      from contact c
      where c.assigned_to is not null and c.archived_at is null and c.merged_into_id is null
        and c.created_at < now() - make_interval(days => ${RULES.coldAfterDays})
        and (exists (select 1 from contact_role r where r.contact_id = c.id) or exists (select 1 from lead l where l.contact_id = c.id))
        and ${recipientOk(sql`c.assigned_to`, sql`c.agency_id`)}
    ) x
    where x.last_touch < now() - make_interval(days => ${RULES.coldAfterDays})
    -- The most recently gone cold first: the ones still worth a call.
    order by x.last_touch desc
    limit ${DETECTOR_LIMIT}`);
  return rows.map((r) => {
    const lastTouch = iso(r.last_touch);
    return {
      kind: 'cold_contact' as const,
      agencyId: r.agency_id,
      userId: r.user_id,
      contactId: r.contact_id,
      listingId: null,
      leadId: null,
      threadId: null,
      appointmentId: null,
      // A new touch makes a new key: dismissed stays dismissed until they go cold again.
      dedupeKey: `cold_contact:${r.contact_id}:${lastTouch?.slice(0, 10)}`,
      facts: { contactName: r.contact_name, lastTouch },
    };
  });
}

/** An email from the contact, 48 hours to 21 days old, and nothing sent on that conversation since. */
export async function detectUnansweredMail(db: DbOrTx): Promise<Detected[]> {
  const rows = await db.execute<{
    agency_id: string; user_id: string; thread_id: string; contact_id: string | null; contact_name: string | null;
    lead_id: string | null; subject: string; received_at: string; message_id: string;
  }>(sql`
    with latest_in as (
      select distinct on (m.thread_id) m.thread_id, m.id as message_id, m.created_at
      from mail_message m
      where m.direction = 'in' and m.created_at > now() - make_interval(days => ${RULES.unansweredWithinDays})
      order by m.thread_id, m.created_at desc, m.id desc
    )
    select t.agency_id, coalesce(l.assigned_to, c.assigned_to) as user_id, t.id as thread_id, t.contact_id, c.name as contact_name,
      t.lead_id, t.subject, li.created_at as received_at, li.message_id
    from latest_in li
    join mail_thread t on t.id = li.thread_id
    left join lead l on l.id = t.lead_id
    left join contact c on c.id = t.contact_id
    where li.created_at < now() - make_interval(hours => ${RULES.unansweredAfterHours})
      and not exists (select 1 from mail_message o where o.thread_id = t.id and o.direction = 'out' and o.created_at > li.created_at)
      -- An offer's conversation is owners' and admins' business; their own notices cover it.
      and (l.id is null or (l.kind <> 'offer' and l.status <> 'closed'))
      and (c.id is null or (c.archived_at is null and c.merged_into_id is null))
      and coalesce(l.assigned_to, c.assigned_to) is not null
      and ${recipientOk(sql`coalesce(l.assigned_to, c.assigned_to)`, sql`t.agency_id`)}
    order by li.created_at desc
    limit ${DETECTOR_LIMIT}`);
  return rows.map((r) => ({
    kind: 'unanswered_mail' as const,
    agencyId: r.agency_id,
    userId: r.user_id,
    contactId: r.contact_id,
    listingId: null,
    leadId: r.lead_id,
    threadId: r.thread_id,
    appointmentId: null,
    dedupeKey: `unanswered_mail:${r.message_id}`,
    facts: { contactName: r.contact_name, subject: r.subject, receivedAt: iso(r.received_at) },
  }));
}

/** An appraisal 3–30 days ago, and since then no note, no email sent and no new appointment with them. */
export async function detectAppraisalFollowUps(db: DbOrTx): Promise<Detected[]> {
  const rows = await db.execute<{ agency_id: string; user_id: string; appointment_id: string; contact_id: string; contact_name: string; title: string; ends_at: string }>(sql`
    select a.agency_id, a.assigned_agent_id as user_id, a.id as appointment_id, a.contact_id, c.name as contact_name, a.title, a.ends_at
    from appointment a
    join contact c on c.id = a.contact_id
    where a.type = 'appraisal' and a.status in ('scheduled', 'completed')
      and a.ends_at < now() - make_interval(days => ${RULES.appraisalAfterDays})
      and a.ends_at > now() - make_interval(days => ${RULES.appraisalWithinDays})
      and a.assigned_agent_id is not null and c.archived_at is null and c.merged_into_id is null
      and not exists (select 1 from note n where n.contact_id = a.contact_id and n.deleted_at is null and n.created_at > a.ends_at)
      and not exists (
        select 1 from mail_message m join mail_thread t on t.id = m.thread_id
        where t.contact_id = a.contact_id and m.direction = 'out' and m.created_at > a.ends_at
      )
      and not exists (select 1 from appointment b where b.contact_id = a.contact_id and b.id <> a.id and b.created_at > a.ends_at)
      and ${recipientOk(sql`a.assigned_agent_id`, sql`a.agency_id`)}
    order by a.ends_at desc
    limit ${DETECTOR_LIMIT}`);
  return rows.map((r) => ({
    kind: 'appraisal_follow_up' as const,
    agencyId: r.agency_id,
    userId: r.user_id,
    contactId: r.contact_id,
    listingId: null,
    leadId: null,
    threadId: null,
    appointmentId: r.appointment_id,
    dedupeKey: `appraisal_follow_up:${r.appointment_id}`,
    facts: { contactName: r.contact_name, title: r.title, endedAt: iso(r.ends_at) },
  }));
}

/** Three or more enquiries in 30 days: someone actively looking. */
export async function detectRepeatInterest(db: DbOrTx): Promise<Detected[]> {
  const rows = await db.execute<{ agency_id: string; user_id: string; contact_id: string; contact_name: string; enquiries: number; latest_lead_id: string; latest_at: string }>(sql`
    select * from (
      select c.agency_id, c.id as contact_id, c.name as contact_name, count(*)::int as enquiries,
        (array_agg(l.id order by l.created_at desc, l.id desc))[1] as latest_lead_id,
        max(l.created_at) as latest_at,
        coalesce(c.assigned_to, (array_agg(l.assigned_to order by l.created_at desc) filter (where l.assigned_to is not null))[1]) as user_id
      from lead l
      join contact c on c.id = l.contact_id
      where l.kind <> 'offer' and l.created_at > now() - make_interval(days => ${RULES.repeatWithinDays})
        and c.archived_at is null and c.merged_into_id is null
      group by c.id
      having count(*) >= ${RULES.repeatEnquiries}
    ) x
    where x.user_id is not null and ${recipientOk(sql`x.user_id`, sql`x.agency_id`)}
    order by x.latest_at desc
    limit ${DETECTOR_LIMIT}`);
  return rows.map((r) => ({
    kind: 'repeat_interest' as const,
    agencyId: r.agency_id,
    userId: r.user_id,
    contactId: r.contact_id,
    listingId: null,
    leadId: r.latest_lead_id,
    threadId: null,
    appointmentId: null,
    // A newer enquiry is a new key; the same burst is told once.
    dedupeKey: `repeat_interest:${r.contact_id}:${r.latest_lead_id}`,
    facts: { contactName: r.contact_name, enquiries: Number(r.enquiries), latestAt: iso(r.latest_at) },
  }));
}

/**
 * A listing that went live in the last 7 days and fits an active buyer's brief (ADR 0055 §6), for
 * the agent the buyer is assigned to. Every bound is compared in SQL against the typed columns —
 * nothing is parsed out of words, and no model ranks anything (#4):
 *
 *   - same agency, same channel (a buying brief meets sale listings, a renting one rent listings);
 *   - price: the listing's range overlaps the brief's (rent: `rent_pw` against the weekly bounds).
 *     A listing with no price stated does NOT match a brief that has a budget — an auction with no
 *     guide could be any price, and a wrong alert costs the agent's trust in all of them;
 *   - bedrooms / bathrooms at least the brief's; unknown on the property → no match when bounded;
 *   - suburb among the brief's (case-insensitive), and type among its types — an empty list is any;
 *   - not a listing this contact has already enquired about: they know of it.
 *
 * The key is the brief and the listing: one alert per pair, ever — editing the brief does not
 * repeat it, a newly matching listing is a new one.
 */
export async function detectBuyerMatches(db: DbOrTx): Promise<Detected[]> {
  const rows = await db.execute<{
    agency_id: string; user_id: string; contact_id: string; contact_name: string; requirement_id: string; listing_id: string;
    br_channel: string; br_price_min: string | null; br_price_max: string | null; br_min_bedrooms: number | null;
    br_min_bathrooms: string | null; br_suburbs: string[]; br_property_types: string[];
    address: string; price_display: string | null; bedrooms: number | null; bathrooms: string | null;
    property_type: string | null; published_at: string;
  }>(sql`
    select br.agency_id, c.assigned_to as user_id, c.id as contact_id, c.name as contact_name,
      br.id as requirement_id, li.id as listing_id,
      br.channel::text as br_channel, br.price_min::text as br_price_min, br.price_max::text as br_price_max,
      br.min_bedrooms as br_min_bedrooms, br.min_bathrooms::text as br_min_bathrooms,
      br.suburbs as br_suburbs, br.property_types as br_property_types,
      concat_ws(', ', nullif(trim(concat(case when p.unit is not null then p.unit || '/' end, concat_ws(' ', p.street_number, p.street))), ''), p.suburb) as address,
      li.price_display, p.bedrooms, p.bathrooms::text as bathrooms, p.property_type, li.published_at
    from buyer_requirement br
    join contact c on c.id = br.contact_id and c.agency_id = br.agency_id
    join listing li on li.agency_id = br.agency_id and li.channel::text = br.channel::text
    join property p on p.id = li.property_id
    -- The listing's price as one range: [low, high]. Sale reads price_from / price_to; rent reads rent_pw.
    cross join lateral (
      select
        case when li.channel = 'rent' then li.rent_pw else coalesce(li.price_from, li.price_to) end as low,
        case when li.channel = 'rent' then li.rent_pw else coalesce(li.price_to, li.price_from) end as high
    ) pr
    where br.status = 'active'
      and li.status = 'live' and li.published_at > now() - make_interval(days => ${RULES.buyerMatchWithinDays})
      and c.assigned_to is not null and c.archived_at is null and c.merged_into_id is null
      and (br.price_min is null or (pr.high is not null and pr.high >= br.price_min))
      and (br.price_max is null or (pr.low is not null and pr.low <= br.price_max))
      and (br.min_bedrooms is null or p.bedrooms >= br.min_bedrooms)
      and (br.min_bathrooms is null or p.bathrooms >= br.min_bathrooms)
      and (cardinality(br.suburbs) = 0 or exists (select 1 from unnest(br.suburbs) s where lower(s) = lower(p.suburb)))
      and (cardinality(br.property_types) = 0 or lower(p.property_type) = any (br.property_types))
      and not exists (select 1 from lead l where l.contact_id = c.id and l.listing_id = li.id)
      and ${recipientOk(sql`c.assigned_to`, sql`br.agency_id`)}
    order by li.published_at desc
    limit ${DETECTOR_LIMIT}`);
  const n = (v: string | number | null) => (v === null ? null : Number(v));
  return rows.map((r) => ({
    kind: 'buyer_match' as const,
    agencyId: r.agency_id,
    userId: r.user_id,
    contactId: r.contact_id,
    listingId: r.listing_id,
    leadId: null,
    threadId: null,
    appointmentId: null,
    dedupeKey: `buyer_match:${r.requirement_id}:${r.listing_id}`,
    facts: {
      contactName: r.contact_name,
      requirementId: r.requirement_id,
      // The brief as it read when it matched, in the same words as the contact's Requirements tab.
      brief: describeRequirement({
        channel: r.br_channel as RequirementChannel,
        priceMin: n(r.br_price_min),
        priceMax: n(r.br_price_max),
        minBedrooms: r.br_min_bedrooms,
        minBathrooms: n(r.br_min_bathrooms),
        suburbs: r.br_suburbs ?? [],
        propertyTypes: r.br_property_types ?? [],
      }),
      address: r.address,
      priceDisplay: r.price_display,
      bedrooms: r.bedrooms,
      bathrooms: r.bathrooms,
      propertyType: r.property_type,
      publishedAt: iso(r.published_at),
    },
  }));
}

export const DETECTORS: Record<OpportunityKind, (db: DbOrTx) => Promise<Detected[]>> = {
  sale_anniversary: detectSaleAnniversaries,
  cold_contact: detectColdContacts,
  unanswered_mail: detectUnansweredMail,
  appraisal_follow_up: detectAppraisalFollowUps,
  repeat_interest: detectRepeatInterest,
  buyer_match: detectBuyerMatches,
};
