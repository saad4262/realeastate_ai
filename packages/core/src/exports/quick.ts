import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { auditLog, contact, listing, property, user, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import type { AuditAction } from '../audit';
import { contactQueryFilters, roleArray } from '../contacts/list-contacts';
import type { ContactListQuery } from '../contacts/contact-schema';
import { listingScopeFilters } from '../listings/scope';
import { adFacts } from '../listings/facts';
import { csvCell } from '../imports/csv';
import { IMPORT_FIELDS } from '../imports/columns';
import { CONTACT_IMPORT_FIELDS } from '../imports/contact-columns';
import { mediaUrl } from '../media/media-url';
import { readLinkKey, linkUrl } from '../media/links';
import { stateTimeZone } from '../inspections/plan';
import { instantToLocalInput } from '../time/local-input';
import { agencyTimeZone } from '../widgets/registry';

/**
 * Quick export (ADR 0101): the rows a list page's filters select, as a CSV the import reads back. Scoped by the
 * screens' own helpers, so an agent gets their own book and an admin the agency's. Streamed a page at a time.
 */
export type QuickDataset = 'contacts' | 'listings';
export const QUICK_DATASETS: readonly QuickDataset[] = ['contacts', 'listings'];

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
] as const;
export const LISTING_EXPORT_HEADERS = [...IMPORT_FIELDS, 'id', 'created_at'] as const;

const BOM = '﻿';
const line = (cells: readonly (string | number | null | undefined)[]) => `${cells.map((c) => csvCell(c == null ? '' : String(c))).join(',')}\r\n`;
/** A numeric column as the import writes it: `780000`, not `780000.00`; empty when null. */
const num = (v: unknown) => (v == null || v === '' ? '' : String(Number(v)));
const day = (v: Date | string | null, tz: string) => (v ? instantToLocalInput(v, tz).slice(0, 10) : '');
const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : '');

export type QuickExport = { filename: string; chunks: AsyncGenerator<string> };

/**
 * Checks permission and writes the audit row BEFORE anything is read, so a refused export reads nothing and an
 * allowed one is on record even if the download is cut. The returned generator adds the row count when it ends.
 */
export async function startQuickExport(
  db: Db,
  actor: Actor,
  dataset: QuickDataset,
  query: Partial<ContactListQuery> = {},
): Promise<QuickExport> {
  const agencyId = actor.agencyId;
  if (!agencyId || !can(actor, 'data:export', { type: 'agency', agencyId })) throw new ExportError('You do not have permission to download this');
  const read = dataset === 'contacts' ? 'contact:read' : 'listing:read';
  if (!can(actor, read, { type: dataset === 'contacts' ? 'contact' : 'listing', agencyId })) throw new ExportError('You do not have permission to download this');
  const all = can(actor, dataset === 'contacts' ? 'contact:read_all' : 'listing:read_all', { type: dataset === 'contacts' ? 'contact' : 'listing', agencyId });
  const filters = dataset === 'contacts' ? Object.keys(query).filter((k) => k !== 'page' && query[k as keyof ContactListQuery] !== undefined) : [];
  const tz = await agencyTimeZone(db, agencyId);
  const action: AuditAction = 'data_exported';
  // Inserted here rather than through recordAudit: the generator needs the row's id to add the count.
  const [logged] = await db
    .insert(auditLog)
    .values({ agencyId, actorUserId: actor.userId, action, detail: { dataset, scope: all ? 'agency' : 'own', filters, rows: null } })
    .returning({ id: auditLog.id });
  const auditId = logged!.id;
  const name = dataset === 'contacts' ? 'customers' : 'listings';
  return { filename: `${name}-${day(new Date(), tz)}.csv`, chunks: stream(db, actor, dataset, query, tz, auditId) };
}

async function* stream(db: Db, actor: Actor, dataset: QuickDataset, query: Partial<ContactListQuery>, tz: string, auditId: string): AsyncGenerator<string> {
  let rows = 0;
  let complete = false;
  try {
    yield BOM + line(dataset === 'contacts' ? CONTACT_EXPORT_HEADERS : LISTING_EXPORT_HEADERS);
    let after: string | null = null;
    for (;;) {
      const page: { id: string; cells: string }[] = dataset === 'contacts' ? await contactPage(db, actor, query, tz, after) : await listingPage(db, actor, after);
      if (!page.length) break;
      rows += page.length;
      after = page[page.length - 1]!.id;
      yield page.map((r) => r.cells).join('');
      if (page.length < EXPORT_PAGE) break;
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
async function contactPage(db: Db, actor: Actor, query: Partial<ContactListQuery>, tz: string, after: string | null) {
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
    ]),
  }));
}

/** Keys of one kind of media on the listing, in gallery order. */
const mediaKeys = (kind: string) =>
  sql<string[] | null>`(select array_agg(m.storage_key order by m.is_main desc, m.sort_order, m.created_at) from media m where m.listing_id = ${listing.id} and m.kind = ${kind})`;

/** One page of listings in the actor's scope, every import column filled from its own table. */
async function listingPage(db: Db, actor: Actor, after: string | null) {
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
    const local = (v: Date | string) => instantToLocalInput(v, tz).replace('T', ' ');
    const openHomes = (r.openHomes ?? []).map(([s, e]) => `${local(s)}-${local(e).slice(11)}`).join('; ');
    return {
      id: r.id,
      cells: line([
        r.externalId, r.unit, r.streetNumber, r.street, r.suburb, r.state, r.postcode, r.propertyType,
        r.bedrooms, num(r.bathrooms), r.carSpaces, num(r.landAreaSqm), num(r.buildingAreaSqm), r.yearBuilt,
        r.channel, r.status, r.headline, r.description, r.priceDisplay, num(r.priceFrom), num(r.priceTo), num(r.rentPw),
        day(r.availableFrom, tz), r.auctionDate ? local(r.auctionDate) : '', day(r.publishedAt, tz), num(r.soldPrice), day(r.soldDate, tz),
        r.agentEmails, urls(r.photos), urls(r.floorplans), link(r.videos), link(r.tours), openHomes,
        r.id, iso(r.createdAt),
      ]),
    };
  });
}
