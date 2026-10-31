import { and, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { visibleContactIdsSql } from '../contacts/visibility';
import { CONTACT_PROPERTY_RELATION_LABELS } from '../contacts/contact-schema';
import { documentScopeFilters } from '../documents/visibility';
import { visibleDealsSql } from '../deals/deals';
import { DEAL_STAGE_LABELS, type DealStage, type DealStatus } from '../deals/stages';
import { listingPriceWords } from '../template-email/listing-values';
import { APPOINTMENT_TYPE_LABELS } from '../appointments/appointment-schema';
import { appointmentVisibleSql, leadVisibleSql, seesAllProperties, visiblePropertyIdsSql } from './visibility';

/**
 * One property with everything the agency has on it (ADR 0065): its campaigns, its deal, the people tied
 * to it, every enquiry and offer, appraisals and visits, documents, and one timeline of all of it. A read
 * only — each section through the rule that already decides who sees that record, so the page can never
 * show what the Leads page, a contact's profile, the calendar or the pipeline would not.
 */

export class PropertyError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'PropertyError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROPERTY_ADDRESS_SQL = sql`concat_ws(', ', nullif(trim(concat(case when p.unit is not null then p.unit || '/' end, concat_ws(' ', p.street_number, p.street))), ''), p.suburb)`;
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));
const when = (v: string | Date | null | undefined) => (v ? new Date(v) : null);

export type PropertyFacts = {
  id: string;
  address: string;
  suburb: string;
  state: string;
  postcode: string;
  propertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  carSpaces: number | null;
  landAreaSqm: number | null;
  buildingAreaSqm: number | null;
  yearBuilt: number | null;
};
export type PropertyListing = {
  id: string;
  channel: string;
  status: string;
  priceText: string;
  soldPrice: number | null;
  soldDate: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  agentName: string | null;
  photoKey: string | null;
  /** May open its edit page: an admin, or named on it (`listing:edit`). */
  mayEdit: boolean;
  /** From going live to the sale, or to today — SQL's count (#4). */
  daysOnMarket: number | null;
};
export type PropertyDeal = {
  id: string;
  stage: DealStage;
  status: DealStatus;
  listingId: string | null;
  salePrice: number | null;
  contractDate: string | null;
  settlementDate: string | null;
  settledAt: Date | null;
  agentName: string | null;
  /** Owners and admins only (the agency sets it, ADR 0064); null for anyone else. */
  commissionSet: boolean | null;
  conditions: { label: string; dueOn: string | null; done: boolean }[];
  events: { kind: string; fromStage: DealStage | null; toStage: DealStage | null; auto: boolean; note: string | null; at: Date; actorName: string | null }[];
};
export type PropertyLead = {
  id: string;
  kind: 'enquiry' | 'inspection' | 'appraisal' | 'offer';
  status: string;
  name: string;
  message: string | null;
  offerAmount: number | null;
  createdAt: Date;
  listingId: string | null;
  contactId: string | null;
};
export type PropertyAppointment = {
  id: string;
  title: string;
  type: string;
  typeLabel: string;
  status: string;
  startsAt: Date;
  timezone: string;
  outcome: string | null;
  contactName: string | null;
  agentName: string | null;
};
export type PropertyInspection = { id: string; kind: 'open' | 'private' | 'auction'; startsAt: Date; listingId: string };
export type PropertyDocument = {
  id: string;
  title: string;
  kind: string;
  isPrivate: boolean;
  createdAt: Date;
  on: 'listing' | 'contact' | 'property';
  contactName: string | null;
  uploader: string | null;
};
export type PropertyPerson = {
  contactId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** What they are to the address, in words: Owner, Vendor, Buyer, Made an offer, Enquired … */
  roles: string[];
  /** Where each role came from, in words. */
  sources: string[];
  linkedAt: Date | null;
};
export type PropertyEventKind = 'offer' | 'enquiry' | 'inspection' | 'appraisal' | 'appointment' | 'open_home' | 'deal' | 'listed' | 'sold' | 'document' | 'linked';
export type PropertyEvent = { at: Date; kind: PropertyEventKind; title: string; detail: string | null; who: string | null };

export type PropertyView = {
  scope: 'agency' | 'own';
  maySeeOffers: boolean;
  /** The agency's clock, for showing dates. */
  timeZone: string;
  facts: PropertyFacts;
  listings: PropertyListing[];
  /** The newest campaign that is not withdrawn, else the newest. */
  current: PropertyListing | null;
  deal: PropertyDeal | null;
  /** Offers on the current campaign — only for those who may see offers (SQL's figures, compared here). */
  offers: { count: number; highest: number | null } | null;
  leads: PropertyLead[];
  appointments: PropertyAppointment[];
  inspections: PropertyInspection[];
  documents: PropertyDocument[];
  people: PropertyPerson[];
  timeline: PropertyEvent[];
};

const LEAD_ROLE: Record<PropertyLead['kind'], string> = { offer: 'Made an offer', enquiry: 'Enquired', inspection: 'Asked to inspect', appraisal: 'Asked for an appraisal' };
const STATUS_WORDS: Record<string, string> = { draft: 'Draft', pending: 'Waiting for approval', live: 'Live', under_offer: 'Under offer', sold: 'Sold', withdrawn: 'Withdrawn' };
export function listingStatusWords(status: string): string {
  return STATUS_WORDS[status] ?? status;
}
const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
export const audWhole = (n: number) => AUD.format(n);

/** May this person open this address at all? One statement; false for a malformed id. */
export async function mayOpenProperty(db: DbOrTx, actor: Actor, propertyId: string): Promise<boolean> {
  if (!UUID.test(propertyId) || !actor.agencyId) return false;
  const [row] = await db.execute<{ ok: boolean }>(sql`select ${propertyId}::uuid in (${visiblePropertyIdsSql(actor)}) as ok`);
  return Boolean(row?.ok);
}

/**
 * Everything on one address that this person may see, or null — "not found" for an address they are not
 * tied to as much as for one that does not exist, so the page never confirms the agency knows it.
 */
export async function getPropertyView(db: DbOrTx, actor: Actor, propertyId: string, opts: { now?: Date } = {}): Promise<PropertyView | null> {
  if (!actor.agencyId || !actor.membershipRole) throw new PropertyError('forbidden', 'You do not have access to properties.');
  if (!(await mayOpenProperty(db, actor, propertyId))) return null;
  const agencyId = actor.agencyId;

  const admin = seesAllProperties(actor);
  const maySeeOffers = can(actor, 'lead:read_offer', { type: 'lead', agencyId });
  const mayCommission = can(actor, 'deal:commission', { type: 'deal', agencyId });
  const now = opts.now ?? new Date();

  const [factsRows, listingRows, dealRows, leadRows, apptRows, inspRows, linkRows, docRows] = await Promise.all([
    db.execute<{
      id: string; address: string; suburb: string; state: string; postcode: string; property_type: string | null; bedrooms: number | null; bathrooms: string | null;
      car_spaces: number | null; land_area_sqm: string | null; building_area_sqm: string | null; year_built: number | null; time_zone: string | null;
    }>(sql`
      select p.id, ${PROPERTY_ADDRESS_SQL} as address, p.suburb, p.state, p.postcode,
        coalesce(fl.property_type, p.property_type) as property_type, coalesce(fl.bedrooms, p.bedrooms) as bedrooms,
        coalesce(fl.bathrooms, p.bathrooms)::text as bathrooms, coalesce(fl.car_spaces, p.car_spaces) as car_spaces,
        coalesce(fl.land_area_sqm, p.land_area_sqm)::text as land_area_sqm, coalesce(fl.building_area_sqm, p.building_area_sqm)::text as building_area_sqm,
        coalesce(fl.year_built, p.year_built) as year_built, (select ag.time_zone from agency ag where ag.id = ${agencyId}) as time_zone
      from property p
      -- ADR 0075: this agency's own newest ad at the address says what the home is; the address fills the gaps.
      left join lateral (select x.* from listing x where x.property_id = p.id and x.agency_id = ${agencyId} order by x.created_at desc limit 1) fl on true
      where p.id = ${propertyId}`),
    db.execute<{
      id: string; channel: string; status: string; price_display: string | null; price_from: string | null; price_to: string | null; rent_pw: string | null;
      sold_price: string | null; sold_date: string | null; published_at: string | null; created_at: string; agent_name: string | null;
      photo_key: string | null; days_on_market: number | null;
    }>(sql`
      select li.id, li.channel::text, li.status::text, li.price_display, li.price_from::text, li.price_to::text, li.rent_pw::text, li.sold_price::text,
        (li.sold_date at time zone ag.time_zone)::date::text as sold_date, li.published_at, li.created_at,
        (select la.snapshot_name from listing_agent la where la.listing_id = li.id order by la.display_order limit 1) as agent_name,
        (select m.storage_key from media m where m.listing_id = li.id and m.kind = 'photo' order by m.is_main desc, m.sort_order asc, m.created_at asc limit 1) as photo_key,
        case when li.published_at is not null and li.status::text not in ('draft', 'pending')
          then greatest(0, (coalesce(li.sold_date, ${now.toISOString()}::timestamptz)::date - li.published_at::date))::int end as days_on_market
      from listing li join agency ag on ag.id = li.agency_id
      where li.property_id = ${propertyId} and li.agency_id = ${agencyId}
      order by li.created_at desc limit 50`),
    db.execute<{
      id: string; stage: DealStage; status: DealStatus; listing_id: string | null; sale_price: string | null; contract_date: string | null; settlement_date: string | null;
      settled_at: string | null; agent_name: string | null; commission_set: boolean; vendor_contact_id: string | null; buyer_contact_id: string | null;
      conditions: { label: string; dueOn: string | null; done: boolean }[] | string | null;
      events: { kind: string; fromStage: DealStage | null; toStage: DealStage | null; auto: boolean; note: string | null; at: string; actorName: string | null }[] | string | null;
    }>(sql`
      select d.id, d.stage, d.status, d.listing_id, d.sale_price::text, d.contract_date::text, d.settlement_date::text, d.settled_at,
        coalesce(u.name, u.email) as agent_name, d.commission_basis is not null as commission_set, d.vendor_contact_id, d.buyer_contact_id,
        (select json_agg(json_build_object('label', c.label, 'dueOn', c.due_on, 'done', c.done_at is not null) order by c.sort, c.created_at)
          from deal_condition c where c.deal_id = d.id) as conditions,
        (select json_agg(json_build_object('kind', e.kind, 'fromStage', e.from_stage, 'toStage', e.to_stage, 'auto', e.auto, 'note', e.note, 'at', e.created_at,
            'actorName', (select coalesce(eu.name, eu.email) from "user" eu where eu.id = e.actor_id)) order by e.created_at desc)
          from deal_event e where e.deal_id = d.id) as events
      from deal d left join "user" u on u.id = d.agent_id
      where d.property_id = ${propertyId} and ${visibleDealsSql(actor)}
      order by (d.status = 'open') desc, d.updated_at desc limit 1`),
    db.execute<{ id: string; kind: PropertyLead['kind']; status: string; name: string; message: string | null; offer_amount: string | null; created_at: string; listing_id: string | null; contact_id: string | null }>(sql`
      select l.id, l.kind, l.status, l.name, l.message, l.offer_amount::text, l.created_at, l.listing_id, l.contact_id
      from lead l where l.property_id = ${propertyId} and ${leadVisibleSql(actor)}
      order by l.created_at desc limit 200`),
    db.execute<{ id: string; title: string; type: string; status: string; starts_at: string; timezone: string; outcome: string | null; contact_name: string | null; agent_name: string | null }>(sql`
      select a.id, a.title, a.type::text, a.status::text, a.starts_at, a.timezone, a.outcome, c.name as contact_name, coalesce(u.name, u.email) as agent_name
      from appointment a left join contact c on c.id = a.contact_id left join "user" u on u.id = a.assigned_agent_id
      where a.property_id = ${propertyId} and ${appointmentVisibleSql(actor)}
      order by a.starts_at desc limit 100`),
    db.execute<{ id: string; kind: PropertyInspection['kind']; starts_at: string; listing_id: string }>(sql`
      select i.id, i.kind::text as kind, i.starts_at, i.listing_id from inspection i join listing li on li.id = i.listing_id
      where li.property_id = ${propertyId} and li.agency_id = ${agencyId}
      order by i.starts_at desc limit 50`),
    db.execute<{ contact_id: string; relation: string; created_at: string; name: string; email: string | null; phone: string | null; linked_by: string | null }>(sql`
      select cp.contact_id, cp.relation::text, cp.created_at, c.name, c.email, c.phone, coalesce(u.name, u.email) as linked_by
      from contact_property cp join contact c on c.id = cp.contact_id left join "user" u on u.id = cp.created_by
      where cp.property_id = ${propertyId} and cp.contact_id in (${visibleContactIdsSql(actor)})
      order by cp.created_at`),
    db.execute<{ id: string; title: string; kind: string; is_private: boolean; created_at: string; listing_id: string | null; contact_id: string | null; contact_name: string | null; uploader: string | null }>(sql`
      select "document"."id", "document"."title", "document"."kind", "document"."is_private", "document"."created_at", "document"."listing_id", "document"."contact_id",
        (select c.name from contact c where c.id = "document"."contact_id") as contact_name,
        (select coalesce(u.name, u.email) from "user" u where u.id = "document"."uploaded_by") as uploader
      from "document"
      where ${and(...documentScopeFilters(actor)) as SQL} and "document"."scope" = 'record' and (
        "document"."property_id" = ${propertyId}
        or "document"."listing_id" in (select li.id from listing li where li.property_id = ${propertyId} and li.agency_id = ${agencyId})
        or "document"."contact_id" in (select cp.contact_id from contact_property cp where cp.property_id = ${propertyId} and cp.relation in ('owner', 'vendor', 'landlord'))
      )
      order by "document"."created_at" desc limit 100`),
  ]);

  const f = factsRows[0];
  if (!f) return null;
  const facts: PropertyFacts = {
    id: f.id, address: f.address, suburb: f.suburb, state: f.state, postcode: f.postcode, propertyType: f.property_type, bedrooms: f.bedrooms,
    bathrooms: num(f.bathrooms), carSpaces: f.car_spaces, landAreaSqm: num(f.land_area_sqm), buildingAreaSqm: num(f.building_area_sqm), yearBuilt: f.year_built,
  };
  const listings: PropertyListing[] = [...listingRows].map((r) => ({
    id: r.id,
    channel: r.channel,
    status: r.status,
    priceText: listingPriceWords({ channel: r.channel, priceDisplay: r.price_display, priceFrom: num(r.price_from), priceTo: num(r.price_to), rentPw: num(r.rent_pw) }),
    soldPrice: num(r.sold_price),
    soldDate: r.sold_date,
    publishedAt: when(r.published_at),
    createdAt: new Date(r.created_at),
    agentName: r.agent_name,
    photoKey: r.photo_key,
    // The caller passes the actor with its listings loaded (loadListingActor), as the Deal tab does.
    mayEdit: can(actor, 'listing:edit', { type: 'listing', id: r.id, agencyId }),
    daysOnMarket: r.days_on_market,
  }));
  const current = listings.find((l) => l.status !== 'withdrawn') ?? listings[0] ?? null;

  const parse = <T,>(v: T[] | string | null): T[] => (v === null ? [] : typeof v === 'string' ? (JSON.parse(v) as T[]) : v);
  const d = dealRows[0];
  const deal: PropertyDeal | null = d
    ? {
        id: d.id, stage: d.stage, status: d.status, listingId: d.listing_id, salePrice: num(d.sale_price), contractDate: d.contract_date, settlementDate: d.settlement_date,
        settledAt: when(d.settled_at), agentName: d.agent_name, commissionSet: mayCommission ? d.commission_set : null,
        conditions: parse(d.conditions),
        events: parse(d.events).map((e) => ({ ...e, at: new Date(e.at) })),
      }
    : null;

  const leads: PropertyLead[] = [...leadRows].map((r) => ({
    id: r.id, kind: r.kind, status: r.status, name: r.name, message: r.message, offerAmount: maySeeOffers ? num(r.offer_amount) : null,
    createdAt: new Date(r.created_at), listingId: r.listing_id, contactId: r.contact_id,
  }));
  const appointments: PropertyAppointment[] = [...apptRows].map((r) => ({
    id: r.id, title: r.title, type: r.type, typeLabel: APPOINTMENT_TYPE_LABELS[r.type as keyof typeof APPOINTMENT_TYPE_LABELS] ?? r.type, status: r.status,
    startsAt: new Date(r.starts_at), timezone: r.timezone, outcome: r.outcome, contactName: r.contact_name, agentName: r.agent_name,
  }));
  const inspections: PropertyInspection[] = [...inspRows].map((r) => ({ id: r.id, kind: r.kind, startsAt: new Date(r.starts_at), listingId: r.listing_id }));
  const documents: PropertyDocument[] = [...docRows].map((r) => ({
    id: r.id, title: r.title, kind: r.kind, isPrivate: r.is_private, createdAt: new Date(r.created_at),
    on: r.listing_id ? 'listing' : r.contact_id ? 'contact' : 'property', contactName: r.contact_name, uploader: r.uploader,
  }));

  // The deal's vendor and buyer, by name — only if this person may open them.
  const dealPeople = d ? [d.vendor_contact_id, d.buyer_contact_id].filter((x): x is string => Boolean(x)) : [];
  const dealContacts = dealPeople.length
    ? await db.execute<{ id: string; name: string; email: string | null; phone: string | null }>(sql`
        select c.id, c.name, c.email, c.phone from contact c
        where c.id in (${sql.join(dealPeople.map((x) => sql`${x}::uuid`), sql`, `)}) and c.id in (${visibleContactIdsSql(actor)})`)
    : [];

  const offersOnCurrent = maySeeOffers && current ? leads.filter((l) => l.kind === 'offer' && l.listingId === current.id && l.offerAmount !== null) : [];
  return {
    scope: admin ? 'agency' : 'own',
    maySeeOffers,
    timeZone: f.time_zone ?? 'Australia/Sydney',
    facts,
    listings,
    current,
    deal,
    offers: maySeeOffers && current ? { count: offersOnCurrent.length, highest: offersOnCurrent.length ? Math.max(...offersOnCurrent.map((l) => l.offerAmount as number)) : null } : null,
    leads,
    appointments,
    inspections,
    documents,
    people: peopleOf([...linkRows], leads, d ? { vendorId: d.vendor_contact_id, buyerId: d.buyer_contact_id, contacts: [...dealContacts] } : null),
    timeline: timelineOf({ listings, deal, leads, appointments, inspections, documents, links: [...linkRows].map((r) => ({ at: new Date(r.created_at), name: r.name, relation: r.relation, by: r.linked_by })), now }),
  };
}

/** One row per person: their links to the address, the deal's vendor and buyer, and every lead they made. Pure. */
export function peopleOf(
  links: { contact_id: string; relation: string; created_at: string; name: string; email: string | null; phone: string | null; linked_by: string | null }[],
  leads: PropertyLead[],
  deal: { vendorId: string | null; buyerId: string | null; contacts: { id: string; name: string; email: string | null; phone: string | null }[] } | null,
): PropertyPerson[] {
  const by = new Map<string, PropertyPerson>();
  const add = (id: string, base: Omit<PropertyPerson, 'roles' | 'sources' | 'contactId'>, role: string, source: string) => {
    const p = by.get(id) ?? { contactId: id, ...base, roles: [], sources: [] };
    if (!p.roles.includes(role)) p.roles.push(role);
    if (!p.sources.includes(source)) p.sources.push(source);
    if (!p.linkedAt && base.linkedAt) p.linkedAt = base.linkedAt;
    by.set(id, p);
  };
  for (const l of links) {
    const label = CONTACT_PROPERTY_RELATION_LABELS[l.relation as keyof typeof CONTACT_PROPERTY_RELATION_LABELS] ?? l.relation;
    add(l.contact_id, { name: l.name, email: l.email, phone: l.phone, linkedAt: new Date(l.created_at) }, label, l.linked_by ? `Linked by ${l.linked_by}` : 'Linked');
  }
  if (deal) {
    for (const c of deal.contacts) {
      if (c.id === deal.vendorId) add(c.id, { name: c.name, email: c.email, phone: c.phone, linkedAt: null }, 'Vendor', 'The deal’s vendor');
      if (c.id === deal.buyerId) add(c.id, { name: c.name, email: c.email, phone: c.phone, linkedAt: null }, 'Buyer', 'The deal’s buyer');
    }
  }
  // Oldest first, so "where it comes from" reads in order.
  for (const l of [...leads].reverse()) {
    if (!l.contactId) continue;
    add(l.contactId, { name: l.name, email: null, phone: null, linkedAt: null }, LEAD_ROLE[l.kind], `${LEAD_ROLE[l.kind]} ${l.createdAt.toISOString().slice(0, 10)}`);
  }
  // Owners and vendors first, then whoever is closest to buying, then the rest by name.
  const rank = (p: PropertyPerson) => (p.roles.some((r) => ['Owner', 'Vendor', 'Landlord'].includes(r)) ? 0 : p.roles.includes('Buyer') ? 1 : p.roles.includes('Made an offer') ? 2 : 3);
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Everything that happened at the address, newest first, from the records already loaded. Pure. */
export function timelineOf(input: {
  listings: PropertyListing[];
  deal: PropertyDeal | null;
  leads: PropertyLead[];
  appointments: PropertyAppointment[];
  inspections: PropertyInspection[];
  documents: PropertyDocument[];
  links: { at: Date; name: string; relation: string; by: string | null }[];
  now: Date;
}): PropertyEvent[] {
  const out: PropertyEvent[] = [];
  for (const l of input.listings) {
    if (l.publishedAt) out.push({ at: l.publishedAt, kind: 'listed', title: `Listing went live`, detail: `${l.channel === 'rent' ? 'For rent' : 'For sale'} · ${l.priceText}`, who: l.agentName });
    if (l.status === 'sold' && l.soldDate) out.push({ at: new Date(`${l.soldDate}T12:00:00Z`), kind: 'sold', title: l.soldPrice ? `Sold · ${audWhole(l.soldPrice)}` : 'Sold', detail: null, who: l.agentName });
  }
  for (const e of input.deal?.events ?? []) {
    if (e.kind === 'edited') continue;
    const stage = e.toStage ? DEAL_STAGE_LABELS[e.toStage] : null;
    const title =
      e.kind === 'condition' ? (e.note ?? 'A condition changed')
      : e.kind === 'settled' ? 'Deal settled'
      : e.kind === 'opened' && stage ? `Deal opened at ${stage}`
      : stage ? `Deal moved to ${stage}`
      : (e.note ?? 'Deal changed');
    out.push({ at: e.at, kind: 'deal', title, detail: e.kind === 'condition' ? null : e.note, who: e.auto ? 'automatic' : e.actorName });
  }
  for (const l of input.leads) {
    const words = l.kind === 'offer' ? `Private offer${l.offerAmount !== null ? ` · ${audWhole(l.offerAmount)}` : ''}` : l.kind === 'enquiry' ? 'Enquiry' : l.kind === 'inspection' ? 'Inspection request' : 'Appraisal request';
    out.push({ at: l.createdAt, kind: l.kind, title: words, detail: l.message ? l.message.slice(0, 160) : null, who: l.name });
  }
  for (const a of input.appointments) {
    if (a.status === 'cancelled') continue;
    const future = a.startsAt > input.now;
    out.push({ at: a.startsAt, kind: a.type === 'appraisal' ? 'appraisal' : 'appointment', title: `${a.typeLabel}${future ? ' (booked)' : ''}`, detail: a.outcome, who: a.contactName });
  }
  for (const i of input.inspections) {
    if (i.startsAt > input.now) continue;
    out.push({ at: i.startsAt, kind: 'open_home', title: i.kind === 'auction' ? 'Auction' : i.kind === 'private' ? 'Private inspection' : 'Open home', detail: null, who: null });
  }
  for (const d of input.documents) out.push({ at: d.createdAt, kind: 'document', title: `${d.title} added`, detail: null, who: d.uploader });
  for (const k of input.links) {
    const label = CONTACT_PROPERTY_RELATION_LABELS[k.relation as keyof typeof CONTACT_PROPERTY_RELATION_LABELS] ?? k.relation;
    out.push({ at: k.at, kind: 'linked', title: `${k.name} linked as ${label.toLowerCase()}`, detail: null, who: k.by });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// ---- The list ----

export const PROPERTY_FILTERS = ['all', 'listed', 'pipeline', 'appraised', 'sold'] as const;
export type PropertyFilter = (typeof PROPERTY_FILTERS)[number];
export const PROPERTY_FILTER_LABELS: Record<PropertyFilter, string> = { all: 'All', listed: 'Listed now', pipeline: 'In the pipeline', appraised: 'Appraised, not listed', sold: 'Sold by us' };
export const PROPERTIES_PAGE_SIZE = 50;

export type PropertyRow = {
  id: string;
  address: string;
  propertyType: string | null;
  bedrooms: number | null;
  /** What it is now, in words: the open deal's stage, else Settled, else the newest campaign's status, else On record. */
  now: { label: string; tone: 'deal' | 'listing' | 'settled' | 'none' };
  ownerName: string | null;
  enquiries: number;
  lastAt: Date | null;
};

/** The Properties list: every address this person may open, newest activity first, in one statement. */
export async function listProperties(
  db: DbOrTx,
  actor: Actor,
  opts: { q?: string | null; filter?: PropertyFilter; page?: number } = {},
): Promise<{ rows: PropertyRow[]; hasMore: boolean; scope: 'agency' | 'own' }> {
  if (!actor.agencyId || !actor.membershipRole || !can(actor, 'listing:read', { type: 'listing', agencyId: actor.agencyId })) {
    throw new PropertyError('forbidden', 'You do not have access to properties.');
  }
  const agencyId = actor.agencyId;
  const page = Math.max(0, Math.floor(opts.page ?? 0));
  const q = opts.q?.trim().slice(0, 120) ?? '';
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const search = q ? sql`and (${PROPERTY_ADDRESS_SQL} ilike ${like} or p.postcode = ${q})` : sql``;
  const filter = (() => {
    switch (opts.filter ?? 'all') {
      case 'listed': return sql`and ll.status in ('live', 'under_offer')`;
      case 'pipeline': return sql`and od.status = 'open'`;
      case 'appraised': return sql`and od.status = 'open' and od.stage = 'appraisal'`;
      case 'sold': return sql`and exists (select 1 from listing s where s.property_id = p.id and s.agency_id = ${agencyId} and s.status = 'sold')`;
      default: return sql``;
    }
  })();
  const contacts = visibleContactIdsSql(actor);
  const rows = await db.execute<{
    id: string; address: string; property_type: string | null; bedrooms: number | null; deal_stage: DealStage | null; deal_status: DealStatus | null;
    listing_status: string | null; owner_name: string | null; enquiries: number; last_at: string | null;
  }>(sql`
    select p.id, ${PROPERTY_ADDRESS_SQL} as address, coalesce(ll.property_type, p.property_type) as property_type,
      coalesce(ll.bedrooms, p.bedrooms) as bedrooms, od.stage as deal_stage, od.status as deal_status, ll.status::text as listing_status,
      (select c.name from contact_property cp join contact c on c.id = cp.contact_id
        where cp.property_id = p.id and cp.relation in ('owner', 'vendor', 'landlord') and c.id in (${contacts}) order by cp.created_at limit 1) as owner_name,
      (select count(*)::int from lead l where l.property_id = p.id and ${leadVisibleSql(actor)}) as enquiries,
      greatest(ll.updated_at, od.updated_at,
        (select max(l.created_at) from lead l where l.property_id = p.id and ${leadVisibleSql(actor)}),
        (select max(a.starts_at) from appointment a where a.property_id = p.id and a.starts_at <= now() and ${appointmentVisibleSql(actor)}),
        (select max(cp.created_at) from contact_property cp where cp.property_id = p.id and cp.contact_id in (${contacts}))) as last_at
    from property p
    left join lateral (select d.stage, d.status, d.updated_at from deal d where d.property_id = p.id and ${visibleDealsSql(actor)}
      order by (d.status = 'open') desc, d.updated_at desc limit 1) od on true
    left join lateral (select li.status, li.updated_at, li.property_type, li.bedrooms from listing li where li.property_id = p.id and li.agency_id = ${agencyId}
      order by li.created_at desc limit 1) ll on true
    where p.id in (${visiblePropertyIdsSql(actor)}) ${search} ${filter}
    order by last_at desc nulls last, p.id
    limit ${PROPERTIES_PAGE_SIZE + 1} offset ${page * PROPERTIES_PAGE_SIZE}`);
  const list = [...rows];
  return {
    scope: seesAllProperties(actor) ? 'agency' : 'own',
    hasMore: list.length > PROPERTIES_PAGE_SIZE,
    rows: list.slice(0, PROPERTIES_PAGE_SIZE).map((r) => ({
      id: r.id,
      address: r.address,
      propertyType: r.property_type,
      bedrooms: r.bedrooms,
      now:
        r.deal_status === 'open' && r.deal_stage
          ? { label: DEAL_STAGE_LABELS[r.deal_stage], tone: 'deal' }
          : r.deal_status === 'settled'
            ? { label: 'Settled', tone: 'settled' }
            : r.listing_status
              ? { label: listingStatusWords(r.listing_status), tone: 'listing' }
              : { label: 'On record', tone: 'none' },
      ownerName: r.owner_name,
      enquiries: r.enquiries,
      lastAt: when(r.last_at),
    })),
  };
}

