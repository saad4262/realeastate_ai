import { and, eq, or, sql } from 'drizzle-orm';
import { contactProperty, lead, property, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { leadScopeFilters, type LeadKind } from '../leads/list-leads';
import { formatAddress } from '../listings/listing-schema';
import {
  linkPropertySchema,
  type ContactPropertyRelation,
  type LinkPropertyInput,
} from './contact-schema';
import { loadContactHead, type ReadableContact } from './get-contact';
import { CONTACT_NOT_FOUND, ContactError } from './list-contacts';
import { contactResource } from './visibility';
import { recordActivity } from './write-contacts';

/**
 * A person's addresses (ADR 0018): the ones somebody tied to them
 * (`contact_property` — owns, selling, rents…) and the ones they enquired or
 * made an offer about (read from `lead`, never copied). One address appears
 * once, with every way it relates to them.
 *
 * The lead half is scoped by `leadScopeFilters`, so an agent is not told about
 * an address through an offer or a lead they could not open.
 */

export type ContactPropertyView = {
  propertyId: string;
  address: string;
  /** Ties somebody recorded, each removable by whoever may edit the contact. */
  links: { id: string; relation: ContactPropertyRelation; note: string | null }[];
  /** The kinds of lead they made about it, e.g. ['enquiry']. Empty when none. */
  leadKinds: LeadKind[];
  /** The ad they enquired through most recently, for the public link. */
  listingId: string | null;
  lastAt: Date;
};

type Row = {
  source: 'link' | 'lead';
  property_id: string;
  unit: string | null;
  street_number: string | null;
  street: string | null;
  suburb: string;
  state: string;
  postcode: string;
  link_id: string | null;
  relation: string | null;
  note: string | null;
  lead_kind: string | null;
  listing_id: string | null;
  at: Date | string;
};

/** One statement: the two halves unioned, grouped by address here. */
export async function listContactProperties(
  db: Db,
  actor: Actor,
  contact: ReadableContact,
): Promise<ContactPropertyView[]> {
  const addressCols = {
    property_id: sql<string>`${property.id}`.as('property_id'),
    unit: sql<string | null>`${property.unit}`.as('unit'),
    street_number: sql<string | null>`${property.streetNumber}`.as('street_number'),
    street: sql<string | null>`${property.street}`.as('street'),
    suburb: sql<string>`${property.suburb}`.as('suburb'),
    state: sql<string>`${property.state}`.as('state'),
    postcode: sql<string>`${property.postcode}`.as('postcode'),
  };
  const linked = db
    .select({
      source: sql<string>`'link'`.as('source'),
      ...addressCols,
      link_id: sql<string>`${contactProperty.id}`.as('link_id'),
      relation: sql<string>`${contactProperty.relation}::text`.as('relation'),
      note: sql<string | null>`${contactProperty.note}`.as('note'),
      lead_kind: sql<null>`null::text`.as('lead_kind'),
      listing_id: sql<null>`null::uuid`.as('listing_id'),
      at: sql<Date>`${contactProperty.createdAt}`.as('at'),
    })
    .from(contactProperty)
    .innerJoin(property, eq(property.id, contactProperty.propertyId))
    .where(eq(contactProperty.contactId, contact.id));
  const enquired = db
    .select({
      source: sql<string>`'lead'`.as('source'),
      ...addressCols,
      link_id: sql<null>`null::uuid`.as('link_id'),
      relation: sql<null>`null::text`.as('relation'),
      note: sql<null>`null::text`.as('note'),
      lead_kind: sql<string>`${lead.kind}::text`.as('lead_kind'),
      listing_id: sql<string | null>`${lead.listingId}`.as('listing_id'),
      at: sql<Date>`${lead.createdAt}`.as('at'),
    })
    .from(lead)
    .innerJoin(property, eq(property.id, lead.propertyId))
    .where(and(eq(lead.contactId, contact.id), ...leadScopeFilters(db, actor)));

  const rows = await db.execute<Row>(sql`
    select * from ((${linked}) union all (${enquired})) t order by t.at desc
  `);

  const byProperty = new Map<string, ContactPropertyView>();
  for (const r of rows) {
    let view = byProperty.get(r.property_id);
    if (!view) {
      view = {
        propertyId: r.property_id,
        address: formatAddress({
          unit: r.unit,
          streetNumber: r.street_number,
          street: r.street,
          suburb: r.suburb,
          state: r.state,
          postcode: r.postcode,
        }),
        links: [],
        leadKinds: [],
        listingId: null,
        lastAt: new Date(r.at),
      };
      byProperty.set(r.property_id, view);
    }
    if (r.source === 'link' && r.link_id && r.relation) {
      view.links.push({ id: r.link_id, relation: r.relation as ContactPropertyRelation, note: r.note });
    } else if (r.lead_kind) {
      const kind = r.lead_kind as LeadKind;
      if (!view.leadKinds.includes(kind)) view.leadKinds.push(kind);
      // Rows arrive newest first, so the first listing seen is the latest ad.
      if (!view.listingId && r.listing_id) view.listingId = r.listing_id;
    }
  }
  return [...byProperty.values()];
}

export type PropertyMatch = { propertyId: string; address: string };

/**
 * Addresses the agency knows — it has listed them or been asked about them —
 * matching a typed fragment. Not every address in the database: another
 * agency's draft is not this agency's business. A brand-new address (never
 * listed, never asked about) is not linkable yet; it needs the listing form's
 * geocoding, which is a later phase.
 */
export async function searchLinkableProperties(
  db: Db,
  actor: Actor,
  q: string,
): Promise<PropertyMatch[]> {
  const term = q.trim();
  if (!actor.agencyId || term.length < 2) return [];
  if (!can(actor, 'contact:read', { type: 'contact', agencyId: actor.agencyId })) return [];
  const pattern = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const rows = await db
    .select({
      id: property.id,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
    })
    .from(property)
    .where(
      and(
        sql`concat_ws(' ', ${property.unit}, ${property.streetNumber}, ${property.street}, ${property.suburb}, ${property.postcode}) ilike ${pattern}`,
        or(
          sql`exists (select 1 from listing l where l.property_id = ${property.id} and l.agency_id = ${actor.agencyId})`,
          sql`exists (select 1 from lead l where l.property_id = ${property.id} and l.agency_id = ${actor.agencyId})`,
        ),
      ),
    )
    .orderBy(property.suburb, property.street, property.streetNumber)
    .limit(10);
  return rows.map((r) => ({ propertyId: r.id, address: formatAddress(r) }));
}

/** May this actor change this contact? Loads it; refuses as not-found if unseen. */
async function requireEditable(db: Db, actor: Actor, contactId: string) {
  const head = await loadContactHead(db, actor, contactId);
  if (!head || head.row.mergedIntoId) throw CONTACT_NOT_FOUND();
  const resource = contactResource(head.facts);
  if (!can(actor, 'contact:read', resource)) throw CONTACT_NOT_FOUND();
  if (!can(actor, 'contact:update', resource)) {
    throw new ContactError('forbidden', 'Only the agent this contact is assigned to, or an admin, may change it');
  }
  return head.row;
}

/** Tie a contact to an address the agency knows. Same address + relation twice is a no-op. */
export async function linkContactProperty(
  db: Db,
  actor: Actor,
  contactId: string,
  input: LinkPropertyInput,
): Promise<void> {
  const row = await requireEditable(db, actor, contactId);
  const parsed = linkPropertySchema.safeParse(input);
  if (!parsed.success) throw new ContactError('invalid', parsed.error.issues[0]?.message ?? 'Check the fields');
  const v = parsed.data;
  const known = await searchKnown(db, actor, v.propertyId);
  if (!known) throw new ContactError('invalid', 'That address is not one your agency knows');

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(contactProperty)
      .values({
        contactId: row.id,
        propertyId: v.propertyId,
        relation: v.relation,
        note: v.note ?? null,
        createdBy: actor.userId,
      })
      .onConflictDoNothing()
      .returning({ id: contactProperty.id });
    if (inserted.length) {
      await recordActivity(tx, actor, row.agencyId, row.id, 'property_linked', {
        propertyId: v.propertyId,
        address: known,
        relation: v.relation,
      });
    }
  });
}

/** The address, if the agency has listed it or been asked about it. */
async function searchKnown(db: Db, actor: Actor, propertyId: string): Promise<string | null> {
  const [r] = await db
    .select({
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
    })
    .from(property)
    .where(
      and(
        eq(property.id, propertyId),
        or(
          sql`exists (select 1 from listing l where l.property_id = ${property.id} and l.agency_id = ${actor.agencyId})`,
          sql`exists (select 1 from lead l where l.property_id = ${property.id} and l.agency_id = ${actor.agencyId})`,
        ),
      ),
    )
    .limit(1);
  return r ? formatAddress(r) : null;
}

/** Remove one recorded tie. The address and its history are untouched. */
export async function unlinkContactProperty(
  db: Db,
  actor: Actor,
  contactId: string,
  linkId: string,
): Promise<void> {
  const row = await requireEditable(db, actor, contactId);
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(contactProperty)
      .where(and(eq(contactProperty.id, linkId), eq(contactProperty.contactId, row.id)))
      .returning({ propertyId: contactProperty.propertyId, relation: contactProperty.relation });
    const gone = removed[0];
    if (!gone) throw new ContactError('not_found', 'That link was already removed');
    await recordActivity(tx, actor, row.agencyId, row.id, 'property_unlinked', {
      propertyId: gone.propertyId,
      relation: gone.relation,
    });
  });
}
