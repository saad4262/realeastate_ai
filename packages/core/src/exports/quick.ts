import { and, asc, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { appointment, auditLog, contact, lead, leadKindEnum, listing, note, property, user, type Db } from '@repo/db';
import { can, type Action, type Actor } from '../permissions';
import type { AuditAction } from '../audit';
import { contactQueryFilters, roleArray } from '../contacts/list-contacts';
import { contactListQuerySchema } from '../contacts/contact-schema';
import { visibleContactIdsSql } from '../contacts/visibility';
import { noteVisibleSql } from '../contacts/notes';
import { leadScopeFilters } from '../leads/list-leads';
import { appointmentScopeFilters } from '../appointments/appointments';
import { visibleDealsSql } from '../deals/deals';
import { listingScopeFilters } from '../listings/scope';
import { adFacts } from '../listings/facts';
import { formatAddress } from '../listings/listing-schema';
import { csvCell } from '../imports/csv';
import { IMPORT_FIELDS } from '../imports/columns';
import { CONTACT_IMPORT_FIELDS } from '../imports/contact-columns';
import { mediaUrl } from '../media/media-url';
import { readLinkKey, linkUrl } from '../media/links';
import { stateTimeZone } from '../inspections/plan';
import { instantToLocalInput } from '../time/local-input';
import { agencyTimeZone } from '../widgets/registry';

/**
 * Quick export (ADR 0104): the rows a list page selects, as CSV. Each dataset is scoped by its screen's own helper,
 * so an agent gets their own book and an admin the agency's. Streamed a page at a time, keyset on `id`.
 */
export const QUICK_DATASETS = ['contacts', 'listings', 'leads', 'appointments', 'deals', 'notes'] as const;
export type QuickDataset = (typeof QUICK_DATASETS)[number];
/** What the route hands over: the page's own URL filters, untrusted. Each dataset parses the ones it knows. */
export type QuickQuery = Record<string, unknown>;

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export const EXPORT_PAGE = 1000;

/** Import's headers first (so the file goes back in), then what only an export knows. */
export const CONTACT_EXPORT_HEADERS = [
  ...CONTACT_IMPORT_FIELDS.filter((f) => !['first_name', 'last_name', 'note'].includes(f)),
  'id', 'source', 'archived', 'created_at',
  // ADR 0107: last, so files read by the import's mapping keep their columns.
  'tags',
] as const;
export const LISTING_EXPORT_HEADERS = [...IMPORT_FIELDS, 'id', 'created_at'] as const;
export const LEAD_EXPORT_HEADERS = ['kind', 'status', 'name', 'email', 'phone', 'message', 'offer_amount', 'address', 'suburb', 'state', 'postcode', 'listing_id', 'assigned_email', 'ai_intent', 'ai_urgency', 'id', 'contact_id', 'created_at'] as const;
export const APPOINTMENT_EXPORT_HEADERS = ['title', 'kind', 'type', 'status', 'starts_at', 'ends_at', 'timezone', 'contact_name', 'contact_email', 'address', 'agent_email', 'location', 'meeting_url', 'notes', 'outcome', 'id', 'contact_id', 'created_at'] as const;
export const DEAL_EXPORT_HEADERS = ['address', 'suburb', 'state', 'postcode', 'stage', 'status', 'agent_email', 'vendor_name', 'vendor_email', 'buyer_name', 'buyer_email', 'sale_price', 'contract_date', 'deposit_amount', 'deposit_paid_on', 'settlement_date', 'buyer_solicitor', 'settled_on', 'commission_basis', 'commission_rate', 'commission_fixed', 'agent_split', 'commission_paid_on', 'id', 'listing_id', 'created_at'] as const;
export const NOTE_EXPORT_HEADERS = ['contact_name', 'contact_email', 'body', 'private', 'author_email', 'created_at', 'updated_at', 'id', 'contact_id'] as const;

export const BOM = '\uFEFF';
export const line = (cells: readonly (string | number | null | undefined)[]) => `${cells.map((c) => csvCell(c == null ? '' : String(c))).join(',')}\r\n`;
/** A numeric column as the import writes it: `780000`, not `780000.00`; empty when null. */
const num = (v: unknown) => (v == null || v === '' ? '' : String(Number(v)));
export const day = (v: Date | string | null, tz: string) => (v ? instantToLocalInput(v, tz).slice(0, 10) : '');
/** `YYYY-MM-DD HH:mm` on a wall clock, as the imports write a time. */
export const at = (v: Date | string | null, tz: string) => (v ? instantToLocalInput(v, tz).replace('T', ' ') : '');
export const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : '');
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);

export type Page = { id: string; cells: string }[];
type Prepared = { filters: string[]; page: (after: string | null) => Promise<Page> };
type Spec = {
  file: string;
  /** Opens the dataset's screen; and widens it to the whole agency (only for the audit's `scope`). */
  read: [Action, string];
  readAll: Action;
  headers: readonly string[];
  prepare: (db: Db, actor: Actor, query: QuickQuery, tz: string) => Prepared;
};

const SPECS: Record<QuickDataset, Spec> = {
  contacts: {
    file: 'customers',
    read: ['contact:read', 'contact'],
    readAll: 'contact:read_all',
    headers: CONTACT_EXPORT_HEADERS,
    prepare: (db, actor, query, tz) => {
      // The directory's own schema: what it drops, the export drops.
      const q = contactListQuerySchema.parse(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, first(v) || undefined])));
      return { filters: (['q', 'role', 'tag', 'source', 'assigned', 'archived'] as const).filter((k) => q[k] !== undefined), page: (after) => contactPage(db, actor, q, tz, after) };
    },
  },
  listings: {
    file: 'listings',
    read: ['listing:read', 'listing'],
    readAll: 'listing:read_all',
    headers: LISTING_EXPORT_HEADERS,
    prepare: (db, actor) => ({ filters: [], page: (after) => listingPage(db, actor, after) }),
  },
  leads: {
    file: 'leads',
    read: ['lead:read', 'lead'],
    readAll: 'lead:read_all',
    headers: LEAD_EXPORT_HEADERS,
    prepare: (db, actor, query) => {
      // The inbox's tabs (`kind`) and the AI filters (`ai`), read as the Leads page reads them.
      const kind = z.enum(leadKindEnum.enumValues).optional().catch(undefined).parse(first(query.kind));
      const ai = z.enum(['buyer', 'seller', 'urgent']).optional().catch(undefined).parse(first(query.ai));
      return { filters: [...(kind ? ['kind'] : []), ...(ai ? ['ai'] : [])], page: (after) => leadPage(db, actor, { kind, ai }, after) };
    },
  },
  appointments: {
    file: 'appointments',
    read: ['appointment:read', 'appointment'],
    readAll: 'appointment:read_all',
    headers: APPOINTMENT_EXPORT_HEADERS,
    // Upcoming and past together: the calendar's two tabs are one history.
    prepare: (db, actor) => ({ filters: [], page: (after) => appointmentPage(db, actor, after) }),
  },
  deals: {
    file: 'deals',
    read: ['listing:read', 'listing'],
    readAll: 'listing:read_all',
    headers: DEAL_EXPORT_HEADERS,
    // Every deal, settled and withdrawn too (the board shows the open ones); `?mine=1` as the board's "Only mine".
    prepare: (db, actor, query, tz) => {
      const mine = first(query.mine) === '1';
      return { filters: mine ? ['mine'] : [], page: (after) => dealPage(db, actor, mine, tz, after) };
    },
  },
  notes: {
    file: 'notes',
    read: ['contact:read', 'contact'],
    readAll: 'contact:read_all',
    headers: NOTE_EXPORT_HEADERS,
    prepare: (db, actor) => ({ filters: [], page: (after) => notePage(db, actor, after) }),
  },
};

/** For the full export (phase 3): a dataset's headers and pages exactly as the quick export reads them, minus its audit row. */
export function datasetPages(db: Db, actor: Actor, dataset: QuickDataset, query: QuickQuery, tz: string): { headers: readonly string[]; page: (after: string | null) => Promise<Page> } {
  const spec = SPECS[dataset];
  return { headers: spec.headers, page: spec.prepare(db, actor, query, tz).page };
}

export type QuickExport = { filename: string; chunks: AsyncGenerator<string> };

/**
 * Checks permission and writes the audit row BEFORE anything is read, so a refused export reads nothing and an
 * allowed one is on record even if the download is cut. The returned generator adds the row count when it ends.
 */
export async function startQuickExport(db: Db, actor: Actor, dataset: QuickDataset, query: QuickQuery = {}): Promise<QuickExport> {
  const spec = SPECS[dataset];
  const agencyId = actor.agencyId;
  if (!spec || !agencyId || !can(actor, 'data:export', { type: 'agency', agencyId }) || !can(actor, spec.read[0], { type: spec.read[1], agencyId })) {
    throw new ExportError('You do not have permission to download this');
  }
  const all = can(actor, spec.readAll, { type: spec.read[1], agencyId });
  const tz = await agencyTimeZone(db, agencyId);
  const prepared = spec.prepare(db, actor, query, tz);
  const action: AuditAction = 'data_exported';
  // Inserted here rather than through recordAudit: the generator needs the row's id to add the count.
  const [logged] = await db
    .insert(auditLog)
    .values({ agencyId, actorUserId: actor.userId, action, detail: { dataset, scope: all ? 'agency' : 'own', filters: prepared.filters, rows: null } })
    .returning({ id: auditLog.id });
  return { filename: `${spec.file}-${day(new Date(), tz)}.csv`, chunks: stream(db, spec.headers, prepared.page, logged!.id) };
}

async function* stream(db: Db, headers: readonly string[], page: Prepared['page'], auditId: string): AsyncGenerator<string> {
  let rows = 0;
  let complete = false;
  try {
    yield BOM + line(headers);
    let after: string | null = null;
    for (;;) {
      const got: Page = await page(after);
      if (!got.length) break;
      rows += got.length;
      after = got[got.length - 1]!.id;
      yield got.map((r) => r.cells).join('');
      if (got.length < EXPORT_PAGE) break;
    }
    complete = true;
  } finally {
    // Runs on a cut download too (the stream's cancel returns the generator), so the log says how far it got.
    await db
      .update(auditLog)
      .set({ detail: sql`${auditLog.detail} || ${JSON.stringify({ rows, complete })}::jsonb` })
      .where(eq(auditLog.id, auditId));
  }
}

const assignee = alias(user, 'export_assignee');

/** One page of customers, ordered by id (a stable total order; keyset, so no page repeats or skips a row). */
async function contactPage(db: Db, actor: Actor, query: z.infer<typeof contactListQuerySchema>, tz: string, after: string | null): Promise<Page> {
  const seesAll = can(actor, 'contact:read_all', { type: 'contact', agencyId: actor.agencyId as string });
  const where: SQL[] = contactQueryFilters(actor, query, seesAll);
  if (after) where.push(gt(contact.id, after));
  const rows = await db
    .select({
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      addressLine: contact.addressLine,
      suburb: contact.addressSuburb,
      state: contact.addressState,
      postcode: contact.addressPostcode,
      roles: sql<unknown>`(select array_agg(r.role order by r.role) from contact_role r where r.contact_id = ${contact.id})`,
      assignedEmail: assignee.email,
      nextAction: contact.nextAction,
      nextActionAt: contact.nextActionAt,
      source: contact.source,
      archivedAt: contact.archivedAt,
      createdAt: contact.createdAt,
      tags: contact.tags,
    })
    .from(contact)
    .leftJoin(assignee, eq(assignee.id, contact.assignedTo))
    .where(and(...where))
    .orderBy(asc(contact.id))
    .limit(EXPORT_PAGE);
  return rows.map((r) => ({
    id: r.id,
    cells: line([
      r.name, r.email, r.phone, r.addressLine, r.suburb, r.state, r.postcode,
      roleArray(r.roles).join(', '), r.assignedEmail, r.nextAction, day(r.nextActionAt, tz),
      r.id, r.source, r.archivedAt ? 'yes' : '', iso(r.createdAt),
      (r.tags ?? []).join(', '),
    ]),
  }));
}

/** Keys of one kind of media on the listing, in gallery order. */
const mediaKeys = (kind: string) =>
  sql<string[] | null>`(select array_agg(m.storage_key order by m.is_main desc, m.sort_order, m.created_at) from media m where m.listing_id = ${listing.id} and m.kind = ${kind})`;

/** One page of listings in the actor's scope, every import column filled from its own table. */
async function listingPage(db: Db, actor: Actor, after: string | null): Promise<Page> {
  const where: SQL[] = listingScopeFilters(actor);
  if (after) where.push(gt(listing.id, after));
  const rows = await db
    .select({
      id: listing.id,
      externalId: listing.externalId,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
      ...adFacts,
      channel: listing.channel,
      status: listing.status,
      headline: listing.headline,
      description: listing.description,
      priceDisplay: listing.priceDisplay,
      priceFrom: listing.priceFrom,
      priceTo: listing.priceTo,
      rentPw: listing.rentPw,
      availableFrom: listing.availableFrom,
      auctionDate: listing.auctionDate,
      publishedAt: listing.publishedAt,
      soldPrice: listing.soldPrice,
      soldDate: listing.soldDate,
      createdAt: listing.createdAt,
      agentEmails: sql<string | null>`(select string_agg(u.email, ';' order by la.display_order, la.created_at) from listing_agent la join "user" u on u.id = la.user_id where la.listing_id = ${listing.id})`,
      photos: mediaKeys('photo'),
      floorplans: mediaKeys('floorplan'),
      videos: mediaKeys('video'),
      tours: mediaKeys('tour'),
      openHomes: sql<[string, string][] | null>`(select json_agg(json_build_array(i.starts_at, i.ends_at) order by i.starts_at) from inspection i where i.listing_id = ${listing.id} and i.kind = 'open')`,
    })
    .from(listing)
    .innerJoin(property, eq(property.id, listing.propertyId))
    .where(and(...where))
    .orderBy(asc(listing.id))
    .limit(EXPORT_PAGE);
  return rows.map((r) => {
    const tz = stateTimeZone(r.state);
    const urls = (keys: string[] | null) => (keys ?? []).map(mediaUrl).filter(Boolean).join('|');
    const link = (keys: string[] | null) => {
      const l = keys?.length ? readLinkKey(keys[0]!) : null;
      return l ? linkUrl(l) : '';
    };
    const openHomes = (r.openHomes ?? []).map(([s, e]) => `${at(s, tz)}-${at(e, tz).slice(11)}`).join('; ');
    return {
      id: r.id,
      cells: line([
        r.externalId, r.unit, r.streetNumber, r.street, r.suburb, r.state, r.postcode, r.propertyType,
        r.bedrooms, num(r.bathrooms), r.carSpaces, num(r.landAreaSqm), num(r.buildingAreaSqm), r.yearBuilt,
        r.channel, r.status, r.headline, r.description, r.priceDisplay, num(r.priceFrom), num(r.priceTo), num(r.rentPw),
        day(r.availableFrom, tz), at(r.auctionDate, tz), day(r.publishedAt, tz), num(r.soldPrice), day(r.soldDate, tz),
        r.agentEmails, urls(r.photos), urls(r.floorplans), link(r.videos), link(r.tours), openHomes,
        r.id, iso(r.createdAt),
      ]),
    };
  });
}

/** One page of the inbox as this actor sees it (offers only for whoever may read them). */
async function leadPage(db: Db, actor: Actor, f: { kind?: (typeof leadKindEnum.enumValues)[number]; ai?: 'buyer' | 'seller' | 'urgent' }, after: string | null): Promise<Page> {
  const where: SQL[] = leadScopeFilters(db, actor);
  if (f.kind) where.push(eq(lead.kind, f.kind));
  if (f.ai === 'urgent') where.push(eq(lead.aiUrgency, 'high'));
  else if (f.ai) where.push(eq(lead.aiIntent, f.ai));
  if (after) where.push(gt(lead.id, after));
  const rows = await db
    .select({
      id: lead.id, kind: lead.kind, status: lead.status, name: lead.name, email: lead.email, phone: lead.phone, message: lead.message,
      offerAmount: lead.offerAmount, unit: property.unit, streetNumber: property.streetNumber, street: property.street,
      suburb: property.suburb, state: property.state, postcode: property.postcode, listingId: lead.listingId,
      assignedEmail: assignee.email, aiIntent: lead.aiIntent, aiUrgency: lead.aiUrgency, contactId: lead.contactId, createdAt: lead.createdAt,
    })
    .from(lead)
    .innerJoin(property, eq(property.id, lead.propertyId))
    .leftJoin(assignee, eq(assignee.id, lead.assignedTo))
    .where(and(...where))
    .orderBy(asc(lead.id))
    .limit(EXPORT_PAGE);
  return rows.map((r) => ({
    id: r.id,
    cells: line([
      r.kind, r.status, r.name, r.email, r.phone, r.message, num(r.offerAmount), formatAddress(r), r.suburb, r.state, r.postcode,
      r.listingId, r.assignedEmail, r.aiIntent, r.aiUrgency, r.id, r.contactId, iso(r.createdAt),
    ]),
  }));
}

/** One page of the calendar this actor sees: client appointments and team meetings, past and upcoming. */
async function appointmentPage(db: Db, actor: Actor, after: string | null): Promise<Page> {
  const where: SQL[] = appointmentScopeFilters(actor);
  if (after) where.push(gt(appointment.id, after));
  const rows = await db
    .select({
      id: appointment.id, title: appointment.title, kind: appointment.kind, type: appointment.type, status: appointment.status,
      startsAt: appointment.startsAt, endsAt: appointment.endsAt, timezone: appointment.timezone,
      contactName: contact.name, contactEmail: contact.email, unit: property.unit, streetNumber: property.streetNumber,
      street: property.street, suburb: property.suburb, state: property.state, postcode: property.postcode,
      agentEmail: assignee.email, location: appointment.location, meetingUrl: appointment.meetingUrl, notes: appointment.notes,
      outcome: appointment.outcome, contactId: appointment.contactId, createdAt: appointment.createdAt,
    })
    .from(appointment)
    .leftJoin(contact, eq(contact.id, appointment.contactId))
    .leftJoin(property, eq(property.id, appointment.propertyId))
    .leftJoin(assignee, eq(assignee.id, appointment.assignedAgentId))
    .where(and(...where))
    .orderBy(asc(appointment.id))
    .limit(EXPORT_PAGE);
  return rows.map((r) => ({
    id: r.id,
    cells: line([
      r.title, r.kind, r.type, r.status, at(r.startsAt, r.timezone), at(r.endsAt, r.timezone), r.timezone, r.contactName, r.contactEmail,
      r.suburb ? formatAddress({ ...r, suburb: r.suburb, state: r.state ?? '', postcode: r.postcode ?? '' }) : '',
      r.agentEmail, r.location, r.meetingUrl, r.notes, r.outcome, r.id, r.contactId, iso(r.createdAt),
    ]),
  }));
}

/** One page of deals this actor sees (`visibleDealsSql`, the board's rule), every stage and status. */
async function dealPage(db: Db, actor: Actor, mine: boolean, tz: string, after: string | null): Promise<Page> {
  const rows = await db.execute<Record<string, string | null>>(sql`
    select d.id, d.listing_id, d.stage::text, d.status, p.unit, p.street_number, p.street, p.suburb, p.state, p.postcode,
      u.email as agent_email, v.name as vendor_name, v.email as vendor_email, b.name as buyer_name, b.email as buyer_email,
      d.sale_price::text, d.contract_date::text, d.deposit_amount::text, d.deposit_paid_on::text, d.settlement_date::text,
      d.buyer_solicitor, (d.settled_at at time zone ${tz})::date::text as settled_on, d.commission_basis, d.commission_rate::text, d.commission_fixed::text,
      d.agent_split::text, d.commission_paid_on::text,
      to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
    from deal d
    join property p on p.id = d.property_id
    left join "user" u on u.id = d.agent_id
    left join contact v on v.id = d.vendor_contact_id
    left join contact b on b.id = d.buyer_contact_id
    where ${visibleDealsSql(actor)}
      ${mine ? sql`and (d.agent_id = ${actor.userId} or exists (select 1 from listing_agent la where la.listing_id = d.listing_id and la.user_id = ${actor.userId}))` : sql``}
      ${after ? sql`and d.id > ${after}` : sql``}
    order by d.id
    limit ${EXPORT_PAGE}`);
  return rows.map((r) => ({
    id: r.id!,
    cells: line([
      formatAddress({ unit: r.unit ?? null, streetNumber: r.street_number ?? null, street: r.street ?? null, suburb: r.suburb ?? '', state: r.state ?? '', postcode: r.postcode ?? '' }),
      r.suburb, r.state, r.postcode, r.stage, r.status, r.agent_email, r.vendor_name, r.vendor_email, r.buyer_name, r.buyer_email,
      num(r.sale_price), r.contract_date, num(r.deposit_amount), r.deposit_paid_on, r.settlement_date, r.buyer_solicitor, r.settled_on,
      r.commission_basis, num(r.commission_rate), num(r.commission_fixed), num(r.agent_split), r.commission_paid_on,
      r.id, r.listing_id, r.created_at,
    ]),
  }));
}

/** One page of notes on the customers this actor sees; private ones only for their author or an admin. */
async function notePage(db: Db, actor: Actor, after: string | null): Promise<Page> {
  const author = alias(user, 'export_note_author');
  const where: SQL[] = [
    eq(note.agencyId, actor.agencyId as string),
    isNull(note.deletedAt),
    noteVisibleSql(actor),
    sql`${note.contactId} in (${visibleContactIdsSql(actor)})`,
  ];
  if (after) where.push(gt(note.id, after));
  const rows = await db
    .select({
      id: note.id, body: note.body, isPrivate: note.isPrivate, createdAt: note.createdAt, updatedAt: note.updatedAt,
      contactId: note.contactId, contactName: contact.name, contactEmail: contact.email, authorEmail: author.email,
    })
    .from(note)
    .innerJoin(contact, eq(contact.id, note.contactId))
    .leftJoin(author, eq(author.id, note.authorId))
    .where(and(...where))
    .orderBy(asc(note.id))
    .limit(EXPORT_PAGE);
  return rows.map((r) => ({
    id: r.id,
    cells: line([r.contactName, r.contactEmail, r.body, r.isPrivate ? 'yes' : '', r.authorEmail, iso(r.createdAt), iso(r.updatedAt), r.id, r.contactId]),
  }));
}
