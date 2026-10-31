import { and, sql, type SQL } from 'drizzle-orm';
import type { Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { leadScopeFilters } from '../leads/list-leads';
import { leadAgentIdSql, listingScopeFilters } from '../listings/scope';
import { contactScopeFilters } from '../contacts/visibility';
import { noteVisibleSql } from '../contacts/notes';
import { appointmentScopeFilters } from '../appointments/appointments';
import { threadScopeFilters } from '../mail/threads';
import { conversationOwnerSql, emailOwnerSql } from '../mail/owner';
import { QUERY_MAX_CHARS } from './guard';

/**
 * L2 of ADR 0042: the named datasets a model-written query reads. Each is a CTE core
 * puts in front of the query, built from the SAME scope helpers every screen and figure
 * uses — so an agent's `leads` are their leads, by the rule the Leads screen applies.
 * They read the `ai` schema's views (search_path = ai), which keep only the ticket's
 * agency (L4); the helpers' SQL names `lead`, `listing_agent` … and resolves to them.
 *
 * Other people's words — email bodies and subjects, enquiry messages, notes — are
 * DISPLAY columns (Part E): in the model's own runs they hold a placeholder, so no text
 * a stranger wrote is ever handed to the model. A tile the person sees gets the text.
 */

export type QueryMode = 'model' | 'person';
export const HIDDEN_TEXT = '[text — shown to the person, not to you]';

type Column = { name: string; type: string; about: string; display?: true };
type Dataset = {
  name: string;
  about: string;
  columns: Column[];
  /** The body of the CTE, as this actor. `text(col)` is a display column's SQL in this mode. */
  build: (db: Db, actor: Actor, text: (expr: SQL) => SQL) => SQL;
};

const ZERO = '00000000-0000-0000-0000-000000000000';
const agencyOf = (a: Actor) => a.agencyId ?? ZERO;

/** "Every agent" is the whole team for an owner/admin; for anyone else, only themselves. */
export const seesWholeTeam = (actor: Actor) => can(actor, 'report:read_agency', { type: 'report', agencyId: agencyOf(actor) });

export const OPEN_DATASETS: readonly Dataset[] = [
  {
    name: 'agents',
    about: 'The people in the agency, one row each (an agent sees only themselves). Use status = \'active\' for the current team.',
    columns: [
      { name: 'agent_id', type: 'uuid', about: 'the person — joins to every *.agent_id' },
      { name: 'name', type: 'text', about: 'their name (or email when no name is set)' },
      { name: 'email', type: 'text', about: 'their email' },
      { name: 'phone', type: 'text', about: 'their phone' },
      { name: 'role', type: 'text', about: 'owner, admin, agent, assistant, property_manager, read_only' },
      { name: 'status', type: 'text', about: 'active, invited, suspended (someone removed from the team is suspended)' },
      { name: 'joined_at', type: 'timestamptz', about: 'when they joined' },
      { name: 'office', type: 'text', about: 'their office name, if any' },
      { name: 'territory_suburbs', type: 'text[]', about: 'their territory — the suburbs they cover (their "location")' },
      { name: 'territory_radius_km', type: 'numeric', about: 'radius of their territory in km' },
      { name: 'specialties', type: 'text[]', about: 'what they specialise in' },
      { name: 'years_experience', type: 'integer', about: 'years in real estate' },
      { name: 'commission_tier', type: 'text', about: 'their commission tier label' },
      { name: 'commission_split_agent_pct', type: 'integer', about: 'the agent’s share of commission, % (a setting — not an amount earned)' },
      { name: 'commission_split_agency_pct', type: 'integer', about: 'the agency’s share of commission, %' },
      { name: 'licence_number', type: 'text', about: 'their real estate licence (registration) number (null: not entered)' },
      { name: 'licence_class', type: 'text', about: 'the licence class, as entered' },
      { name: 'licence_expiry', type: 'timestamptz', about: 'when the licence expires' },
    ],
    build: (_db, actor) => sql`select u.id as agent_id, coalesce(nullif(u.name, ''), u.email) as name, u.email, u.phone,
        m.role::text as role, m.status::text as status, m.joined_at, o.name as office,
        coalesce(p.territory_suburbs, '{}'::text[]) as territory_suburbs, p.territory_radius_km, coalesce(p.specialties, '{}'::text[]) as specialties,
        p.years_experience, p.commission_tier, p.commission_split_agent as commission_split_agent_pct, p.commission_split_agency as commission_split_agency_pct,
        p.licence_number, p.licence_class, p.licence_expiry
      from membership m join "user" u on u.id = m.user_id
      left join agent_profile p on p.user_id = m.user_id left join office o on o.id = m.office_id
      where m.agency_id = ${agencyOf(actor)}${seesWholeTeam(actor) ? sql`` : sql` and m.user_id = ${actor.userId}`}`,
  },
  {
    name: 'listings',
    about: 'Listings (for sale or lease). A sale is a listing with status \'sold\'; "revenue" means the sum of sold_price.',
    columns: [
      { name: 'listing_id', type: 'uuid', about: 'the listing' },
      { name: 'status', type: 'text', about: 'draft, pending (awaiting approval), live, under_offer, sold, withdrawn' },
      { name: 'channel', type: 'text', about: 'sale, rent, sold, leased' },
      { name: 'price_from', type: 'numeric', about: 'asking price, low end, AUD (null: not given)' },
      { name: 'price_to', type: 'numeric', about: 'asking price, high end, AUD' },
      { name: 'price_display', type: 'text', about: 'the price as advertised, words' },
      { name: 'rent_pw', type: 'numeric', about: 'weekly rent, AUD (leases)' },
      { name: 'sold_price', type: 'numeric', about: 'sold price, AUD; null when undisclosed' },
      { name: 'sold_date', type: 'timestamptz', about: 'when it sold' },
      { name: 'published_at', type: 'timestamptz', about: 'when it went live' },
      { name: 'auction_date', type: 'timestamptz', about: 'auction date, if any' },
      { name: 'created_at', type: 'timestamptz', about: 'when it was created' },
      { name: 'agent_id', type: 'uuid', about: 'the lead agent (one per listing)' },
      { name: 'address', type: 'text', about: 'street address' },
      { name: 'suburb', type: 'text', about: 'suburb' },
      { name: 'postcode', type: 'text', about: 'postcode' },
      { name: 'property_type', type: 'text', about: 'house, unit, townhouse, land …' },
      { name: 'bedrooms', type: 'integer', about: 'bedrooms' },
      { name: 'bathrooms', type: 'numeric', about: 'bathrooms' },
      { name: 'land_area_sqm', type: 'numeric', about: 'land area, m²' },
      { name: 'headline', type: 'text', about: 'the advert headline', display: true },
    ],
    build: (_db, actor, text) => sql`select listing.id as listing_id, listing.status::text as status, listing.channel::text as channel,
        listing.price_from, listing.price_to, listing.price_display, listing.rent_pw, listing.sold_price, listing.sold_date,
        listing.published_at, listing.auction_date, listing.created_at, ${leadAgentIdSql(sql`listing.id`)} as agent_id,
        concat_ws(' ', nullif(concat_ws('/', pr.unit, pr.street_number), ''), pr.street) as address, pr.suburb, pr.postcode,
        coalesce(listing.property_type, pr.property_type) as property_type, coalesce(listing.bedrooms, pr.bedrooms) as bedrooms,
        coalesce(listing.bathrooms, pr.bathrooms) as bathrooms, coalesce(listing.land_area_sqm, pr.land_area_sqm) as land_area_sqm, ${text(sql`listing.headline`)} as headline
      from listing join property pr on pr.id = listing.property_id
      where ${and(...listingScopeFilters(actor))}`,
  },
  {
    name: 'listing_agents',
    about: 'Every agent named on a listing (a listing can have several; listings.agent_id is the lead one).',
    columns: [
      { name: 'listing_id', type: 'uuid', about: 'the listing' },
      { name: 'agent_id', type: 'uuid', about: 'an agent on it' },
      { name: 'role', type: 'text', about: 'lead, co, property_manager' },
      { name: 'display_order', type: 'integer', about: '0 = first shown' },
    ],
    build: (_db, actor) => sql`select la.listing_id, la.user_id as agent_id, la.role::text as role, la.display_order
      from listing_agent la where la.listing_id in (select listing.id from listing where ${and(...listingScopeFilters(actor))})`,
  },
  {
    // ADR 0044 B: the dashboards' own definition of a sale (status sold, dated by the sale, under its lead agent).
    name: 'sales',
    about: 'One row per sold listing, dated by the sale and counted under its lead agent. "Sales value" / "revenue" = sum(sold_price); an undisclosed price is null — count it apart, never as $0.',
    columns: [
      { name: 'listing_id', type: 'uuid', about: 'the listing that sold — joins listings.listing_id' },
      { name: 'sold_date', type: 'timestamptz', about: 'when it sold' },
      { name: 'sold_price', type: 'numeric', about: 'sold price, AUD; null when undisclosed' },
      { name: 'price_disclosed', type: 'boolean', about: 'false when the price was not disclosed' },
      { name: 'agent_id', type: 'uuid', about: 'the lead agent (one per sale)' },
      { name: 'suburb', type: 'text', about: 'suburb' },
      { name: 'postcode', type: 'text', about: 'postcode' },
      { name: 'property_type', type: 'text', about: 'house, unit, townhouse, land …' },
      { name: 'bedrooms', type: 'integer', about: 'bedrooms' },
      { name: 'days_on_market', type: 'numeric', about: 'days from going live to the sale (null: never live, or no dates)' },
    ],
    build: (_db, actor) => sql`select listing.id as listing_id, listing.sold_date, listing.sold_price, listing.sold_price is not null as price_disclosed,
        ${leadAgentIdSql(sql`listing.id`)} as agent_id, pr.suburb, pr.postcode, coalesce(listing.property_type, pr.property_type) as property_type,
        coalesce(listing.bedrooms, pr.bedrooms) as bedrooms,
        case when listing.published_at is not null and listing.published_at <= listing.sold_date
             then round(extract(epoch from (listing.sold_date - listing.published_at)) / 86400, 1) end as days_on_market
      from listing join property pr on pr.id = listing.property_id
      where listing.status = 'sold' and ${and(...listingScopeFilters(actor))}`,
  },
  {
    name: 'leads',
    about: 'Enquiries, appraisal requests and offers that came in (kind). One row per lead.',
    columns: [
      { name: 'lead_id', type: 'uuid', about: 'the lead' },
      { name: 'created_at', type: 'timestamptz', about: 'when it came in' },
      { name: 'kind', type: 'text', about: 'enquiry, inspection, appraisal, offer' },
      { name: 'status', type: 'text', about: 'new, contacted, qualified, closed' },
      { name: 'source', type: 'text', about: 'where it came from: website, manual …' },
      { name: 'offer_amount', type: 'numeric', about: 'the offer, AUD (offers only)' },
      { name: 'agent_id', type: 'uuid', about: 'who it is assigned to (null: nobody)' },
      { name: 'listing_id', type: 'uuid', about: 'the listing it is about, if any' },
      { name: 'contact_id', type: 'uuid', about: 'the contact it belongs to' },
      { name: 'contact_name', type: 'text', about: 'the person’s name as they gave it' },
      { name: 'contact_email', type: 'text', about: 'their email' },
      { name: 'contact_phone', type: 'text', about: 'their phone' },
      { name: 'suburb', type: 'text', about: 'suburb of the property it is about' },
      { name: 'property_type', type: 'text', about: 'type of that property' },
      { name: 'bedrooms', type: 'integer', about: 'bedrooms of that property' },
      { name: 'message', type: 'text', about: 'what they wrote', display: true },
    ],
    build: (db, actor, text) => sql`select lead.id as lead_id, lead.created_at, lead.kind::text as kind, lead.status::text as status,
        lead.source, lead.offer_amount, lead.assigned_to as agent_id, lead.listing_id, lead.contact_id, lead.name as contact_name,
        lead.email as contact_email, lead.phone as contact_phone, pr.suburb, coalesce(ll.property_type, pr.property_type) as property_type,
        coalesce(ll.bedrooms, pr.bedrooms) as bedrooms, ${text(sql`lead.message`)} as message
      from lead join property pr on pr.id = lead.property_id left join listing ll on ll.id = lead.listing_id
      where ${and(...leadScopeFilters(db, actor))}`,
  },
  {
    // ADR 0044 B: lead response time, worked out once here rather than by every query. Only an email a
    // PERSON sent (sent_by set) counts as a reply; phone calls and SMS are not held.
    name: 'lead_responses',
    about: 'One row per lead (the same leads as `leads`) with how fast it was first answered by email: our first sent email on any of its conversations, written by a person, at or after it came in. Unanswered leads have replied = false and null times — average response_minutes over replied leads, and count the unanswered ones apart.',
    columns: [
      { name: 'lead_id', type: 'uuid', about: 'the lead — joins leads.lead_id' },
      { name: 'created_at', type: 'timestamptz', about: 'when the lead came in' },
      { name: 'kind', type: 'text', about: 'enquiry, inspection, appraisal, offer' },
      { name: 'agent_id', type: 'uuid', about: 'who the lead is assigned to (null: nobody)' },
      { name: 'listing_id', type: 'uuid', about: 'the listing it is about, if any' },
      { name: 'suburb', type: 'text', about: 'suburb of the property it is about' },
      { name: 'replied', type: 'boolean', about: 'answered by email yet' },
      { name: 'first_reply_at', type: 'timestamptz', about: 'when the first email answer was sent (null: not yet)' },
      { name: 'replied_by_agent_id', type: 'uuid', about: 'who sent that first answer' },
      { name: 'response_minutes', type: 'numeric', about: 'minutes from the lead to the first answer (null: not yet)' },
    ],
    build: (db, actor) => sql`select lead.id as lead_id, lead.created_at, lead.kind::text as kind, lead.assigned_to as agent_id, lead.listing_id, pr.suburb,
        r.first_reply_at is not null as replied, r.first_reply_at, r.replied_by as replied_by_agent_id,
        round(extract(epoch from (r.first_reply_at - lead.created_at)) / 60, 1) as response_minutes
      from lead join property pr on pr.id = lead.property_id
      left join lateral (
        select mm.created_at as first_reply_at, mm.sent_by as replied_by
        from mail_message mm join mail_thread mt on mt.id = mm.thread_id
        where mt.lead_id = lead.id and mm.direction = 'out' and mm.status = 'sent' and mm.sent_by is not null and mm.created_at >= lead.created_at
        order by mm.created_at limit 1
      ) r on true
      where ${and(...leadScopeFilters(db, actor))}`,
  },
  {
    name: 'contacts',
    about: 'The agency’s contacts (buyers, sellers, landlords, tenants …), merged duplicates left out.',
    columns: [
      { name: 'contact_id', type: 'uuid', about: 'the contact' },
      { name: 'name', type: 'text', about: 'name' },
      { name: 'email', type: 'text', about: 'email' },
      { name: 'phone', type: 'text', about: 'phone' },
      { name: 'agent_id', type: 'uuid', about: 'who they are assigned to (null: nobody)' },
      { name: 'source', type: 'text', about: 'how they were added: enquiry, offer, email, manual, import' },
      { name: 'roles', type: 'text[]', about: 'any of: buyer, seller, landlord, tenant, investor' },
      { name: 'created_at', type: 'timestamptz', about: 'when added' },
      { name: 'marketing_consent', type: 'boolean', about: 'agreed to marketing email' },
      { name: 'email_opted_out', type: 'boolean', about: 'unsubscribed' },
      { name: 'archived', type: 'boolean', about: 'archived' },
      { name: 'next_action_at', type: 'timestamptz', about: 'when the next follow-up is due' },
      { name: 'next_action', type: 'text', about: 'the next follow-up, words', display: true },
    ],
    build: (_db, actor, text) => sql`select contact.id as contact_id, contact.name, contact.email, contact.phone,
        contact.assigned_to as agent_id, contact.source::text as source,
        coalesce((select array_agg(r.role::text order by r.role::text) from contact_role r where r.contact_id = contact.id), '{}'::text[]) as roles,
        contact.created_at, contact.marketing_consent_at is not null as marketing_consent, contact.email_opt_out_at is not null as email_opted_out,
        contact.archived_at is not null as archived, contact.next_action_at, ${text(sql`contact.next_action`)} as next_action
      from contact where ${and(...contactScopeFilters(actor))}`,
  },
  {
    name: 'threads',
    about: 'Email conversations with contacts, one row each. awaiting_reply: their last word is newer than our last sent email.',
    columns: [
      { name: 'thread_id', type: 'uuid', about: 'the conversation' },
      { name: 'created_at', type: 'timestamptz', about: 'when it began' },
      { name: 'last_message_at', type: 'timestamptz', about: 'latest message either way' },
      { name: 'last_inbound_at', type: 'timestamptz', about: 'their latest message' },
      { name: 'last_outbound_at', type: 'timestamptz', about: 'our latest sent message (null: never)' },
      { name: 'awaiting_reply', type: 'boolean', about: 'waiting for our answer' },
      { name: 'agent_id', type: 'uuid', about: 'whose conversation it is' },
      { name: 'contact_id', type: 'uuid', about: 'the contact' },
      { name: 'contact_name', type: 'text', about: 'their name' },
      { name: 'contact_email', type: 'text', about: 'their email' },
      { name: 'contact_phone', type: 'text', about: 'their phone' },
      { name: 'lead_id', type: 'uuid', about: 'the lead it started from, if any' },
      { name: 'lead_kind', type: 'text', about: 'that lead’s kind' },
      { name: 'subject', type: 'text', about: 'subject line', display: true },
    ],
    build: (db, actor, text) => sql`select mail_thread.id as thread_id, mail_thread.created_at, mail_thread.last_message_at, mail_thread.last_inbound_at,
        w.last_out as last_outbound_at,
        ((lead.id is null or lead.status <> 'closed') and greatest(w.last_in, lead.created_at) is not null
          and greatest(w.last_in, lead.created_at) > coalesce(w.last_out, '-infinity'::timestamptz)) as awaiting_reply,
        ${conversationOwnerSql} as agent_id, mail_thread.contact_id, coalesce(contact.name, mail_thread.contact_name) as contact_name,
        coalesce(contact.email, mail_thread.contact_email) as contact_email, contact.phone as contact_phone,
        mail_thread.lead_id, lead.kind::text as lead_kind, ${text(sql`mail_thread.subject`)} as subject
      from mail_thread
      left join lead on lead.id = mail_thread.lead_id
      left join contact on contact.id = mail_thread.contact_id
      left join lateral (
        select max(mm.created_at) filter (where mm.direction = 'in') as last_in,
               max(mm.created_at) filter (where mm.direction = 'out' and mm.status = 'sent') as last_out
        from mail_message mm where mm.thread_id = mail_thread.id
      ) w on true
      where ${and(...threadScopeFilters(db, actor))}`,
  },
  {
    name: 'emails',
    about: 'Every email message, in (from a contact) and out (from the agency). Replies from contacts are direction = \'in\'.',
    columns: [
      { name: 'email_id', type: 'uuid', about: 'the message' },
      { name: 'thread_id', type: 'uuid', about: 'its conversation' },
      { name: 'at', type: 'timestamptz', about: 'when it was received or sent' },
      { name: 'direction', type: 'text', about: 'in or out' },
      { name: 'status', type: 'text', about: 'received, queued, sent, failed' },
      { name: 'kind', type: 'text', about: 'what it was about, when known: enquiry, inspection, appraisal, offer, template …' },
      { name: 'agent_id', type: 'uuid', about: 'the agent it belongs to (out: who sent it; in: whose conversation)' },
      { name: 'from_email', type: 'text', about: 'sender address' },
      { name: 'from_name', type: 'text', about: 'sender name' },
      { name: 'to_emails', type: 'text', about: 'recipients, comma separated' },
      { name: 'contact_id', type: 'uuid', about: 'the contact of the conversation' },
      { name: 'contact_name', type: 'text', about: 'their name' },
      { name: 'contact_email', type: 'text', about: 'their email' },
      { name: 'contact_phone', type: 'text', about: 'their phone' },
      { name: 'lead_id', type: 'uuid', about: 'the lead of the conversation, if any' },
      { name: 'subject', type: 'text', about: 'subject line', display: true },
      { name: 'body', type: 'text', about: 'the message text', display: true },
    ],
    build: (db, actor, text) => sql`select mail_message.id as email_id, mail_message.thread_id, mail_message.created_at as at,
        mail_message.direction::text as direction, mail_message.status::text as status, mail_message.kind,
        ${emailOwnerSql} as agent_id, mail_message.from_email, mail_message.from_name, array_to_string(mail_message.to_emails, ', ') as to_emails,
        mail_thread.contact_id, coalesce(contact.name, mail_thread.contact_name) as contact_name,
        coalesce(contact.email, mail_thread.contact_email) as contact_email, contact.phone as contact_phone, mail_thread.lead_id,
        ${text(sql`mail_message.subject`)} as subject, ${text(sql`mail_message.text`)} as body
      from mail_message
      join mail_thread on mail_thread.id = mail_message.thread_id
      left join lead on lead.id = mail_thread.lead_id
      left join contact on contact.id = mail_thread.contact_id
      where ${and(...threadScopeFilters(db, actor))}`,
  },
  {
    name: 'appointments',
    about: 'Appointments: inspections, appraisals, meetings (kind client) and team meetings (kind team).',
    columns: [
      { name: 'appointment_id', type: 'uuid', about: 'the appointment' },
      { name: 'kind', type: 'text', about: 'client or team' },
      { name: 'type', type: 'text', about: 'appraisal, phone_call, zoom, inspection, meeting' },
      { name: 'status', type: 'text', about: 'scheduled, completed, cancelled, rescheduled' },
      { name: 'starts_at', type: 'timestamptz', about: 'start' },
      { name: 'ends_at', type: 'timestamptz', about: 'end' },
      { name: 'created_at', type: 'timestamptz', about: 'when it was booked' },
      { name: 'agent_id', type: 'uuid', about: 'the agent it is assigned to' },
      { name: 'contact_id', type: 'uuid', about: 'who it is with' },
      { name: 'contact_name', type: 'text', about: 'their name' },
      { name: 'suburb', type: 'text', about: 'suburb of the property, if any' },
      { name: 'title', type: 'text', about: 'title', display: true },
      { name: 'outcome', type: 'text', about: 'the outcome written after it', display: true },
    ],
    build: (_db, actor, text) => sql`select appointment.id as appointment_id, appointment.kind::text as kind, appointment.type::text as type,
        appointment.status::text as status, appointment.starts_at, appointment.ends_at, appointment.created_at,
        appointment.assigned_agent_id as agent_id, appointment.contact_id, contact.name as contact_name, pr.suburb,
        ${text(sql`appointment.title`)} as title, ${text(sql`appointment.outcome`)} as outcome
      from appointment
      left join contact on contact.id = appointment.contact_id
      left join property pr on pr.id = appointment.property_id
      where ${and(...appointmentScopeFilters(actor))}`,
  },
  {
    name: 'notes',
    about: 'Notes written on contacts (private notes only for their author, unless an admin).',
    columns: [
      { name: 'note_id', type: 'uuid', about: 'the note' },
      { name: 'contact_id', type: 'uuid', about: 'the contact' },
      { name: 'agent_id', type: 'uuid', about: 'who wrote it' },
      { name: 'created_at', type: 'timestamptz', about: 'when' },
      { name: 'is_private', type: 'boolean', about: 'private to its author' },
      { name: 'body', type: 'text', about: 'the note', display: true },
    ],
    build: (_db, actor, text) => sql`select note.id as note_id, note.contact_id, note.author_id as agent_id, note.created_at, note.is_private,
        ${text(sql`note.body`)} as body
      from note
      where note.deleted_at is null and ${noteVisibleSql(actor)}
        and note.contact_id in (select contact.id from contact where ${and(...contactScopeFilters(actor))})`,
  },
];

export const OPEN_DATASET_NAMES = OPEN_DATASETS.map((d) => d.name);

/** The `ai` schema's view names: a query may not define a CTE called one of these. */
export const AI_VIEW_NAMES = [
  'user', 'membership', 'agent_profile', 'office', 'listing', 'listing_agent', 'property', 'lead', 'contact', 'contact_role',
  'contact_property', 'mail_thread', 'mail_message', 'appointment', 'appointment_participant', 'note',
];

/** Display columns by dataset, for the console (drawn as text) and the tests. */
export const DISPLAY_COLUMNS: Record<string, string[]> = Object.fromEntries(
  OPEN_DATASETS.map((d) => [d.name, d.columns.filter((c) => c.display).map((c) => c.name)]),
);

/** `WITH a AS (…), b AS (…)` for the datasets a query uses, as this actor, in this mode. */
export function datasetCtes(db: Db, actor: Actor, names: string[], mode: QueryMode): SQL {
  const text = (expr: SQL) => (mode === 'person' ? expr : sql`${HIDDEN_TEXT}::text`);
  const parts = OPEN_DATASETS.filter((d) => names.includes(d.name)).map((d) => sql`${sql.identifier(d.name)} as (${d.build(db, actor, text)})`);
  return sql`with ${sql.join(parts, sql`, `)}`;
}

/**
 * The data dictionary (Part C): one text, the same for every agency and every request,
 * built from the definitions above — so it can never describe a column that is not there.
 */
export function dataDictionary(): string {
  const sets = OPEN_DATASETS.map(
    (d) =>
      `## ${d.name}\n${d.about}\n${d.columns.map((c) => `- ${c.name} (${c.type}${c.display ? ', text hidden from you' : ''}): ${c.about}`).join('\n')}`,
  ).join('\n\n');
  return `${DICTIONARY_RULES}\n\n# Datasets\n\n${sets}\n\n${NOT_HELD}`;
}

const DICTIONARY_RULES = `# How to query

- Write ONE PostgreSQL SELECT over the datasets below (by these names only; no schema, no other table). You may define your own CTEs with other names.
- Joins: every agent_id joins agents.agent_id; listing_id, lead_id, contact_id and thread_id join across datasets.
- Money is AUD; times are timestamptz (UTC). Group days in the agency's time zone: date_trunc('day', created_at at time zone '<tz>').
- An "average per day" is the total divided by the number of days in the period (use generate_series for days with none), not the average of the days that had some.
- PER AGENT (per suburb, per listing …): start FROM that dataset and LEFT JOIN the activity onto it, so someone with nothing still appears (as 0). Always include agents.agent_id in a per-agent result. Use agents.status = 'active' for the current team unless asked otherwise.
- NEVER join two activities (listings, sales, leads, emails, appointments …) to the same base row in one FROM: the rows multiply and every sum and count is wrong. Aggregate EACH activity in its own CTE at the grain of the result (GROUP BY agent_id, suburb …), then LEFT JOIN those CTEs onto the base — exactly one row per base row. A per-agent result that names an agent twice is refused.
- Counts from a LEFT JOIN are coalesce(x, 0); an average with nothing to average stays null (shown as "No information yet").
- "Active listings" = listings.status in ('live', 'under_offer'). "This month" = created_at (or sold_date) >= date_trunc('month', now() at time zone '<tz>') at time zone '<tz>'.
- Columns marked "text hidden from you" hold a placeholder in your runs: select them to show the person, but never filter, group or search on them.
- At most 500 rows are kept for a tile and 50 come back to you. Order your rows. A query may be up to ${QUERY_MAX_CHARS} characters.
- If an error comes back, read it and the hint with it, and correct the query.

Worked example — "agents with their licence number, active listings in Pakenham and Officer, sales value this month and their average lead response time, all together" (time zone Australia/Melbourne):
with act as (select agent_id, count(*) as active_listings from listings where status in ('live', 'under_offer') and suburb in ('Pakenham', 'Officer') group by agent_id),
     sold as (select agent_id, sum(sold_price) as sales_value, count(*) filter (where not price_disclosed) as undisclosed from sales
              where sold_date >= date_trunc('month', now() at time zone 'Australia/Melbourne') at time zone 'Australia/Melbourne' group by agent_id),
     resp as (select agent_id, round(avg(response_minutes), 1) as avg_response_minutes, count(*) filter (where not replied) as unanswered from lead_responses group by agent_id)
select a.agent_id, a.name, a.licence_number, coalesce(act.active_listings, 0) as active_listings, coalesce(sold.sales_value, 0) as sales_value,
       coalesce(sold.undisclosed, 0) as undisclosed_sales, resp.avg_response_minutes, coalesce(resp.unanswered, 0) as unanswered_leads
from agents a left join act on act.agent_id = a.agent_id left join sold on sold.agent_id = a.agent_id left join resp on resp.agent_id = a.agent_id
where a.status = 'active' order by a.name`;

const NOT_HELD = `# What this system does NOT hold

Commission amounts earned (only the split settings), marketing or advertising spend, expenses, payroll, website visits or traffic, portal (realestate.com.au / Domain) statistics, call logs, SMS (so a response time counts email answers only — say so), social media, vendor-paid advertising, property valuations (other than asking and sold prices), market data about other agencies, and anything about another agency. If a question needs one of these, or anything not in a dataset above, say plainly that the account does not hold it — never stand in a near-match without saying so.`;
