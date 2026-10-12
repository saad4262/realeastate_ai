import { sql, type SQL } from 'drizzle-orm';
import { appointment, contact, lead, listing, mailMessage, property } from '@repo/db';
import type { DbOrTx } from '@repo/db';
import type { Action, Actor } from '../permissions';
import { leadScopeFilters } from '../leads/list-leads';
import { appointmentScopeFilters } from '../appointments/appointments';
import { APPOINTMENT_STATUS_LABELS, APPOINTMENT_STATUSES, APPOINTMENT_TYPE_LABELS, APPOINTMENT_TYPES } from '../appointments/appointment-schema';
import { threadScopeFilters } from '../mail/threads';
import { emailOwnerSql } from '../mail/owner';
import { leadAgentIdSql, listingScopeFilters } from '../listings/scope';
import { contactScopeFilters } from '../contacts/visibility';
import type { WidgetFormat } from '../widgets/detail';

/**
 * The semantic catalog (ADR 0036 §1, §4): every dataset, measure and dimension a
 * dashboard tile can be made of — WRITTEN HERE, reviewed like any other code.
 * The model can only name these ids; the compiler (compile.ts) looks each one
 * up in these maps and never puts a spec value anywhere but a bound parameter.
 *
 * Nothing in this file uses `sql.raw`: every fragment is a constant template.
 *
 * Each dataset's FROM keeps the table names its scope helper names (`listing`,
 * `lead`, `appointment`, `mail_thread`, `contact`) — an alias would be a
 * Postgres error, not a leak. The person a row belongs to is always joined as
 * `agent_user` (one row or none: every join here is many-to-one, so no row is
 * ever counted twice).
 */

export type SemanticContext = { db: DbOrTx; actor: Actor };

/** A named aggregate over the dataset's base columns. */
export type MeasureDef = {
  label: string;
  /** A short phrase for the assistant's catalog. */
  about: string;
  format: WidgetFormat;
  /** An aggregate over the base CTE's columns (`base.*`). */
  expr: SQL;
  /** True: nothing to count is 0. False: nothing to work it out from is "—" (a median of no sales), never 0. */
  zero: boolean;
  /** Asked of the viewer on top of the dataset's permission. */
  permission?: Action;
  /** Figures that always come with this one on the total — the rule lives in the measure (ADR 0036 §4). */
  companions?: { label: string; expr: SQL }[];
};

/** A named group-by / filter expression over the dataset's tables. */
export type DimensionDef = {
  label: string;
  about: string;
  /** The value of this dimension for one row, as text (time dims: a timestamp, see `time`). */
  expr: SQL;
  permission?: Action;
  /** The values a filter may name (checked before compiling); none = free text, bound as a parameter. */
  values?: readonly string[];
  /** How a value is shown ("phone_call" → "Phone call"). */
  valueLabels?: Record<string, string>;
};

export type TimeUnit = 'hour' | 'day' | 'week' | 'month';
export const TIME_UNITS: readonly TimeUnit[] = ['hour', 'day', 'week', 'month'];
/** How each step is written (Postgres `to_char`) — the same as the fixed widgets' trends. */
export const TIME_FORMATS: Record<TimeUnit, string> = { hour: 'HH24:00', day: 'Dy DD Mon', week: 'DD Mon', month: 'Mon YYYY' };

export type DatasetDef = {
  label: string;
  about: string;
  /** `event`: rows happen in a range (leads, sales). `snapshot`: the state now (active listings) — no range. */
  kind: 'event' | 'snapshot';
  /** May the viewer read this dataset at all. */
  permission: Action;
  /** FROM and the fixed joins. Constant. */
  from: SQL;
  /** The viewer's rows — ANDed FIRST onto every statement (I1). */
  scope: (ctx: SemanticContext) => SQL[];
  /** Always true of a row in this dataset (constant). */
  always: SQL[];
  /** The instant a row happened at (event datasets). */
  time?: SQL;
  /** Rows can be in the future (appointments): a trend runs to the end of the range, not to today. */
  future?: boolean;
  /** Columns of the base CTE that the measures read. Constant expressions. */
  columns: Record<string, SQL>;
  measures: Record<string, MeasureDef>;
  dimensions: Record<string, DimensionDef>;
  /** The default range when a spec does not say. */
  defaultRange: string;
  /** The full-page report (ADR 0036 Phase 4): figures, and breakdowns by these dimensions. */
  /** `measure` on a breakdown: what to count instead of the tile's first measure (emails by direction count every email). */
  report: { kpis: string[]; breakdowns: { dimension: string; chart: 'bars' | 'donut' | 'columns'; measure?: string }[] };
};

const AGENT_LABEL = sql`coalesce(nullif(agent_user.name, ''), agent_user.email, 'No agent')`;

/** "By agent" is a per-person performance view: owners and admins (ADR 0036 decided Q5, ADR 0034). */
const agentDimension = (about: string): DimensionDef => ({
  label: 'Agent',
  about,
  expr: AGENT_LABEL,
  permission: 'report:read_agency',
});

const PRICE_BANDS = ['<$500k', '$500–750k', '$750k–1M', '$1–1.5M', '$1.5–2M', '$2M+'] as const;
const priceBand = (col: SQL): SQL => sql`case
    when ${col} is null then 'No price'
    when ${col} < 500000 then '<$500k'
    when ${col} < 750000 then '$500–750k'
    when ${col} < 1000000 then '$750k–1M'
    when ${col} < 1500000 then '$1–1.5M'
    when ${col} < 2000000 then '$1.5–2M'
    else '$2M+' end`;

const LISTING_FROM = sql`listing
  join property on property.id = listing.property_id
  left join "user" agent_user on agent_user.id = ${leadAgentIdSql(listing.id)}`;

const PROPERTY_DIMENSIONS = {
  suburb: { label: 'Suburb', about: 'the property’s suburb', expr: sql`coalesce(nullif(${property.suburb}, ''), 'Not stated')` },
  property_type: { label: 'Property type', about: 'house, apartment, townhouse…', expr: sql`coalesce(nullif(${property.propertyType}, ''), 'Not stated')` },
  bedrooms: { label: 'Bedrooms', about: 'number of bedrooms', expr: sql`coalesce(${property.bedrooms}::text, 'Not stated')` },
} satisfies Record<string, DimensionDef>;

const LEAD_KIND_LABELS = { enquiry: 'Enquiry', inspection: 'Inspection request', appraisal: 'Appraisal request', agency: 'Agency address', offer: 'Offer' };

export const DATASETS = {
  /** Sold listings (ADR 0027 decision 2: "revenue" is Sold value; an undisclosed price is never $0). */
  sales: {
    label: 'Sales',
    about: 'listings the agency sold, dated by the sale date',
    kind: 'event',
    permission: 'report:read_agency',
    from: LISTING_FROM,
    scope: ({ actor }) => listingScopeFilters(actor),
    always: [sql`${listing.status} = 'sold'`],
    time: sql`${listing.soldDate}`,
    columns: {
      price: sql`${listing.soldPrice}`,
      dom: sql`case when ${listing.publishedAt} is not null and ${listing.publishedAt} <= ${listing.soldDate}
                    then extract(epoch from (${listing.soldDate} - ${listing.publishedAt})) / 86400 end`,
    },
    measures: {
      count: { label: 'Sales', about: 'number of sales', format: 'count', expr: sql`count(*)`, zero: true },
      sold_value: {
        label: 'Sold value',
        about: 'total of disclosed sold prices ("revenue")',
        format: 'money',
        expr: sql`coalesce(sum(price), 0)`,
        zero: true,
        companions: [{ label: 'Sold without a disclosed price (not counted as $0)', expr: sql`count(*) - count(price)` }],
      },
      priced: { label: 'Sales with a price', about: 'sales whose price is disclosed', format: 'count', expr: sql`count(price)`, zero: true },
      undisclosed: { label: 'No disclosed price', about: 'sales without a disclosed price (never $0)', format: 'count', expr: sql`count(*) - count(price)`, zero: true },
      average_price: { label: 'Average sold price', about: 'average of disclosed prices', format: 'money', expr: sql`round(avg(price))`, zero: false },
      median_price: { label: 'Median sold price', about: 'median of disclosed prices', format: 'money', expr: sql`round(percentile_cont(0.5) within group (order by price)::numeric)`, zero: false },
      median_days_on_market: { label: 'Median days on market', about: 'median days from publishing to sale', format: 'days', expr: sql`round(percentile_cont(0.5) within group (order by dom)::numeric)`, zero: false },
    },
    dimensions: {
      agent: agentDimension('the listing’s lead agent'),
      ...PROPERTY_DIMENSIONS,
      price_band: { label: 'Price band', about: 'sold price band', expr: priceBand(sql`${listing.soldPrice}`), values: [...PRICE_BANDS, 'No price'] },
    },
    defaultRange: '30d',
    report: {
      kpis: ['priced', 'average_price', 'median_price', 'median_days_on_market', 'undisclosed'],
      breakdowns: [
        { dimension: 'agent', chart: 'bars' },
        { dimension: 'property_type', chart: 'donut' },
        { dimension: 'suburb', chart: 'bars' },
        { dimension: 'price_band', chart: 'columns' },
      ],
    },
  },

  /** The agency's listings as they are now (a snapshot: no range). */
  listings: {
    label: 'Listings',
    about: 'the agency’s listings as they are right now',
    kind: 'snapshot',
    permission: 'listing:read',
    from: LISTING_FROM,
    scope: ({ actor }) => listingScopeFilters(actor),
    always: [],
    columns: {
      status: sql`${listing.status}::text`,
      channel: sql`${listing.channel}::text`,
      asking: sql`${listing.priceFrom}`,
      pub: sql`${listing.publishedAt}`,
    },
    measures: {
      active: {
        label: 'Active listings',
        about: 'live + under offer',
        format: 'count',
        expr: sql`count(*) filter (where status in ('live', 'under_offer'))`,
        zero: true,
        companions: [
          { label: 'Live', expr: sql`count(*) filter (where status = 'live')` },
          { label: 'Under offer', expr: sql`count(*) filter (where status = 'under_offer')` },
        ],
      },
      live: { label: 'Live', about: 'on the market', format: 'count', expr: sql`count(*) filter (where status = 'live')`, zero: true },
      under_offer: { label: 'Under offer', about: 'under offer', format: 'count', expr: sql`count(*) filter (where status = 'under_offer')`, zero: true },
      pending: { label: 'Waiting for approval', about: 'submitted, not yet published', format: 'count', expr: sql`count(*) filter (where status = 'pending')`, zero: true },
      count: { label: 'Listings', about: 'every listing in any status', format: 'count', expr: sql`count(*)`, zero: true },
      median_asking: {
        label: 'Median asking price (from)',
        about: 'median "price from" of active listings for sale',
        format: 'money',
        expr: sql`round(percentile_cont(0.5) within group (order by asking) filter (where status in ('live', 'under_offer') and channel = 'sale')::numeric)`,
        zero: false,
      },
      median_days_listed: {
        label: 'Median days listed',
        about: 'median days since publishing, active listings',
        format: 'days',
        expr: sql`round(percentile_cont(0.5) within group (order by extract(epoch from (now() - pub)) / 86400) filter (where status in ('live', 'under_offer') and pub is not null)::numeric)`,
        zero: false,
      },
    },
    dimensions: {
      status: {
        label: 'Status',
        about: 'draft, pending, live, under offer, sold, withdrawn',
        expr: sql`${listing.status}::text`,
        values: ['draft', 'pending', 'live', 'under_offer', 'sold', 'withdrawn'],
        valueLabels: { draft: 'Draft', pending: 'Waiting for approval', live: 'Live', under_offer: 'Under offer', sold: 'Sold', withdrawn: 'Withdrawn' },
      },
      channel: { label: 'For sale or lease', about: 'sale or rent', expr: sql`${listing.channel}::text`, values: ['sale', 'rent'], valueLabels: { sale: 'For sale', rent: 'For lease' } },
      agent: agentDimension('the listing’s lead agent'),
      ...PROPERTY_DIMENSIONS,
      price_band: { label: 'Asking price band', about: 'asking ("from") price band', expr: priceBand(sql`${listing.priceFrom}`), values: [...PRICE_BANDS, 'No price'] },
    },
    defaultRange: '30d',
    report: {
      kpis: ['pending', 'median_days_listed', 'median_asking', 'live', 'under_offer'],
      breakdowns: [
        { dimension: 'property_type', chart: 'donut' },
        { dimension: 'suburb', chart: 'bars' },
        { dimension: 'agent', chart: 'bars' },
        { dimension: 'price_band', chart: 'columns' },
      ],
    },
  },

  /** Enquiries (never offers: ADR 0027 — an offer is not a lead figure). */
  leads: {
    label: 'Leads',
    about: 'enquiries, inspection and appraisal requests (never offers), dated when they came in',
    kind: 'event',
    permission: 'lead:read',
    from: sql`lead
      join property on property.id = lead.property_id
      left join "user" agent_user on agent_user.id = lead.assigned_to`,
    scope: ({ db, actor }) => leadScopeFilters(db as never, actor),
    always: [sql`${lead.kind} <> 'offer'`],
    time: sql`${lead.createdAt}`,
    columns: {
      status: sql`${lead.status}::text`,
      unassigned: sql`${lead.assignedTo} is null`,
      property_id: sql`${lead.propertyId}`,
    },
    measures: {
      count: { label: 'Leads', about: 'number of leads', format: 'count', expr: sql`count(*)`, zero: true },
      still_new: { label: 'Still new', about: 'leads nobody has moved on from "new"', format: 'count', expr: sql`count(*) filter (where status = 'new')`, zero: true },
      unassigned: { label: 'Not assigned', about: 'leads with no agent', format: 'count', expr: sql`count(*) filter (where unassigned)`, zero: true },
      properties: { label: 'Properties enquired about', about: 'distinct properties', format: 'count', expr: sql`count(distinct property_id)`, zero: true },
    },
    dimensions: {
      agent: agentDimension('the agent the lead is assigned to'),
      kind: { label: 'Type of enquiry', about: 'enquiry, inspection, appraisal', expr: sql`${lead.kind}::text`, values: ['enquiry', 'inspection', 'appraisal'], valueLabels: LEAD_KIND_LABELS },
      status: {
        label: 'Status',
        about: 'new, contacted, qualified, closed',
        expr: sql`${lead.status}::text`,
        values: ['new', 'contacted', 'qualified', 'closed'],
        valueLabels: { new: 'New', contacted: 'Contacted', qualified: 'Qualified', closed: 'Closed' },
      },
      property: {
        label: 'Property',
        about: 'the address enquired about',
        expr: sql`concat_ws(', ', nullif(concat_ws(' ', ${property.streetNumber}, ${property.street}), ''), ${property.suburb})`,
      },
      ...PROPERTY_DIMENSIONS,
    },
    defaultRange: '7d',
    report: {
      kpis: ['still_new', 'unassigned', 'properties'],
      breakdowns: [
        { dimension: 'kind', chart: 'donut' },
        { dimension: 'status', chart: 'bars' },
        { dimension: 'agent', chart: 'bars' },
        { dimension: 'property', chart: 'bars' },
      ],
    },
  },

  /** Appointments by their start time — which can be in the future. */
  appointments: {
    label: 'Appointments',
    about: 'appointments and meetings, dated by when they start (can be in the future)',
    kind: 'event',
    permission: 'appointment:read',
    from: sql`appointment left join "user" agent_user on agent_user.id = appointment.assigned_agent_id`,
    scope: ({ actor }) => appointmentScopeFilters(actor),
    always: [],
    time: sql`${appointment.startsAt}`,
    future: true,
    columns: { status: sql`${appointment.status}::text`, type: sql`${appointment.type}::text` },
    measures: {
      active: {
        label: 'Appointments',
        about: 'still on (scheduled or rescheduled) — the usual count',
        format: 'count',
        expr: sql`count(*) filter (where status in ('scheduled', 'rescheduled'))`,
        zero: true,
      },
      count: { label: 'All appointments', about: 'every appointment in any status', format: 'count', expr: sql`count(*)`, zero: true },
      completed: { label: 'Completed', about: 'marked completed', format: 'count', expr: sql`count(*) filter (where status = 'completed')`, zero: true },
      cancelled: { label: 'Cancelled', about: 'cancelled', format: 'count', expr: sql`count(*) filter (where status = 'cancelled')`, zero: true },
      appraisals: { label: 'Appraisals booked', about: 'appraisals still on', format: 'count', expr: sql`count(*) filter (where type = 'appraisal' and status in ('scheduled', 'rescheduled'))`, zero: true },
    },
    dimensions: {
      agent: agentDimension('the agent it is assigned to'),
      type: { label: 'Type', about: 'appraisal, phone call, zoom, inspection, meeting', expr: sql`${appointment.type}::text`, values: APPOINTMENT_TYPES, valueLabels: APPOINTMENT_TYPE_LABELS },
      status: { label: 'Status', about: 'scheduled, rescheduled, completed, cancelled', expr: sql`${appointment.status}::text`, values: APPOINTMENT_STATUSES, valueLabels: APPOINTMENT_STATUS_LABELS },
      meeting_with: {
        label: 'With',
        about: 'a client, or only the team',
        expr: sql`${appointment.kind}::text`,
        values: ['client', 'team'],
        valueLabels: { client: 'Client', team: 'Team only' },
      },
    },
    defaultRange: 'this_week',
    report: {
      kpis: ['appraisals', 'completed', 'cancelled'],
      breakdowns: [
        { dimension: 'type', chart: 'donut' },
        { dimension: 'agent', chart: 'bars' },
        { dimension: 'status', chart: 'bars' },
        { dimension: 'meeting_with', chart: 'bars' },
      ],
    },
  },

  /** Emails in conversations the viewer may read; each on its person by the one email owner (ADR 0036 P3). */
  emails: {
    label: 'Emails',
    about: 'emails received and sent in the agency’s conversations (not queued ones)',
    kind: 'event',
    permission: 'mail:read',
    from: sql`mail_message
      join mail_thread on mail_thread.id = mail_message.thread_id
      left join lead on lead.id = mail_thread.lead_id
      left join contact on contact.id = mail_thread.contact_id
      left join "user" agent_user on agent_user.id = (${emailOwnerSql})`,
    scope: ({ db, actor }) => threadScopeFilters(db, actor),
    always: [sql`${mailMessage.status} <> 'queued'`],
    time: sql`${mailMessage.createdAt}`,
    columns: {
      dir: sql`${mailMessage.direction}::text`,
      status: sql`${mailMessage.status}::text`,
      thread: sql`${mailMessage.threadId}`,
    },
    measures: {
      received: { label: 'Emails received', about: 'emails that came in', format: 'count', expr: sql`count(*) filter (where dir = 'in')`, zero: true },
      sent: { label: 'Emails sent', about: 'emails sent successfully', format: 'count', expr: sql`count(*) filter (where dir = 'out' and status = 'sent')`, zero: true },
      failed: { label: 'Failed to send', about: 'sends that failed', format: 'count', expr: sql`count(*) filter (where dir = 'out' and status = 'failed')`, zero: true },
      count: { label: 'Emails', about: 'received + sent + failed', format: 'count', expr: sql`count(*)`, zero: true },
      conversations: { label: 'Conversations', about: 'distinct conversations with email', format: 'count', expr: sql`count(distinct thread)`, zero: true },
    },
    dimensions: {
      agent: agentDimension('whose email it is: the sender, or the conversation’s agent for one received'),
      direction: { label: 'Direction', about: 'received or sent', expr: sql`${mailMessage.direction}::text`, values: ['in', 'out'], valueLabels: { in: 'Received', out: 'Sent' } },
      conversation: {
        label: 'Kind of conversation',
        about: 'enquiry, inspection, appraisal, offer, or the agency address',
        expr: sql`coalesce(${lead.kind}::text, 'agency')`,
        values: ['enquiry', 'inspection', 'appraisal', 'offer', 'agency'],
        valueLabels: LEAD_KIND_LABELS,
      },
    },
    defaultRange: '7d',
    report: {
      kpis: ['sent', 'failed', 'conversations'],
      breakdowns: [
        { dimension: 'direction', chart: 'donut', measure: 'count' },
        { dimension: 'agent', chart: 'bars' },
        { dimension: 'conversation', chart: 'bars' },
      ],
    },
  },

  /** Contacts in the directory, dated by when they were added. */
  contacts: {
    label: 'Contacts',
    about: 'people in the contact directory (not archived), dated by when they were added — use the range "all_time" for everyone',
    kind: 'event',
    permission: 'contact:read',
    from: sql`contact left join "user" agent_user on agent_user.id = contact.assigned_to`,
    scope: ({ actor }) => contactScopeFilters(actor),
    always: [sql`${contact.archivedAt} is null`],
    time: sql`${contact.createdAt}`,
    columns: {
      consent: sql`${contact.marketingConsentAt} is not null and ${contact.emailOptOutAt} is null`,
      opted_out: sql`${contact.emailOptOutAt} is not null`,
    },
    measures: {
      count: { label: 'Contacts', about: 'number of contacts', format: 'count', expr: sql`count(*)`, zero: true },
      with_consent: { label: 'Agreed to marketing', about: 'consent recorded and not unsubscribed', format: 'count', expr: sql`count(*) filter (where consent)`, zero: true },
      opted_out: { label: 'Unsubscribed', about: 'asked for no marketing email', format: 'count', expr: sql`count(*) filter (where opted_out)`, zero: true },
    },
    dimensions: {
      agent: agentDimension('the agent the contact is assigned to'),
      source: {
        label: 'How they came',
        about: 'enquiry, offer, email, manual, import',
        expr: sql`${contact.source}::text`,
        values: ['enquiry', 'offer', 'email', 'manual', 'import'],
        valueLabels: { enquiry: 'Enquiry', offer: 'Offer', email: 'Email', manual: 'Added by hand', import: 'Imported' },
      },
    },
    defaultRange: 'all_time',
    report: {
      kpis: ['with_consent', 'opted_out'],
      breakdowns: [
        { dimension: 'source', chart: 'donut' },
        { dimension: 'agent', chart: 'bars' },
      ],
    },
  },
} satisfies Record<string, DatasetDef>;

export type DatasetId = keyof typeof DATASETS;
export const DATASET_IDS = Object.keys(DATASETS) as DatasetId[];

export function datasetDef(id: string): DatasetDef | undefined {
  return (DATASETS as Record<string, DatasetDef>)[id];
}
