import { eq, sql } from 'drizzle-orm';
import { lead, listing, mailThread, property, type Db } from '@repo/db';
import { formatAddress } from '../listings/listing-schema';
import type { LeadKind, LeadStatus } from './list-leads';
import { adFacts } from '../listings/facts';

/**
 * Everything an agent needs to know about a lead at a glance — what kind of
 * approach, about which property, through which ad, and what the person
 * wants — for the emails that tell an agency about one.
 *
 * One statement. Every figure is read from a column (#4): the offer is what the
 * visitor typed, the price is the ad's own `price_display` string, the last
 * sale is the recorded `sold_price`. Nothing here computes or compares money.
 */
export type LeadContext = {
  leadId: string;
  agencyId: string;
  /** The lead's own listing link — null on an offer. */
  listingId: string | null;
  assignedTo: string | null;
  /** Its email conversation (ADR 0016). */
  threadId: string | null;
  kind: LeadKind;
  status: LeadStatus;
  createdAt: Date;
  name: string;
  email: string;
  phone: string | null;
  message: string | null;
  /** Dollars, on an offer. */
  offerAmount: number | null;
  propertyId: string;
  address: string;
  property: {
    type: string | null;
    bedrooms: number | null;
    bathrooms: number | null;
    carSpaces: number | null;
    landAreaSqm: number | null;
  };
  /** The ad it came through, if any. */
  listing: {
    id: string;
    headline: string | null;
    priceDisplay: string | null;
    status: string;
    channel: string;
  } | null;
  /** The most recent recorded sale at the address, if there is one. */
  lastSale: { price: number; date: Date | null } | null;
};

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export async function loadLeadContext(db: Db, leadId: string): Promise<LeadContext | null> {
  const [r] = await db
    .select({
      leadId: lead.id,
      agencyId: lead.agencyId,
      leadListingId: lead.listingId,
      assignedTo: lead.assignedTo,
      threadId: mailThread.id,
      kind: lead.kind,
      status: lead.status,
      createdAt: lead.createdAt,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      message: lead.message,
      offerAmount: lead.offerAmount,
      propertyId: lead.propertyId,
      formattedAddress: property.formattedAddress,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
      propertyType: adFacts.propertyType,
      bedrooms: adFacts.bedrooms,
      bathrooms: adFacts.bathrooms,
      carSpaces: adFacts.carSpaces,
      landAreaSqm: adFacts.landAreaSqm,
      listingId: listing.id,
      headline: listing.headline,
      priceDisplay: listing.priceDisplay,
      listingStatus: listing.status,
      channel: listing.channel,
      lastSale: sql<{ price: string; date: string | null } | null>`(
        select json_build_object('price', s.sold_price, 'date', s.sold_date)
        from listing s
        where s.property_id = ${lead.propertyId} and s.status = 'sold' and s.sold_price is not null
        order by s.sold_date desc nulls last, s.id desc
        limit 1
      )`,
    })
    .from(lead)
    .innerJoin(property, eq(property.id, lead.propertyId))
    .leftJoin(listing, eq(listing.id, lead.listingId))
    .leftJoin(mailThread, eq(mailThread.leadId, lead.id))
    .where(eq(lead.id, leadId))
    .limit(1);
  if (!r) return null;

  const sale = r.lastSale && typeof r.lastSale === 'object' ? r.lastSale : null;
  return {
    leadId: r.leadId,
    agencyId: r.agencyId,
    listingId: r.leadListingId ?? null,
    assignedTo: r.assignedTo ?? null,
    threadId: r.threadId ?? null,
    kind: r.kind as LeadKind,
    status: r.status as LeadStatus,
    createdAt: new Date(r.createdAt ?? Date.now()),
    name: r.name,
    email: r.email,
    phone: r.phone ?? null,
    message: r.message ?? null,
    offerAmount: num(r.offerAmount),
    propertyId: r.propertyId,
    address:
      r.formattedAddress?.trim() ||
      formatAddress({
        unit: r.unit,
        streetNumber: r.streetNumber,
        street: r.street,
        suburb: r.suburb,
        state: r.state,
        postcode: r.postcode,
      }),
    property: {
      type: r.propertyType ?? null,
      bedrooms: r.bedrooms ?? null,
      bathrooms: num(r.bathrooms),
      carSpaces: r.carSpaces ?? null,
      landAreaSqm: num(r.landAreaSqm),
    },
    listing: r.listingId
      ? {
          id: r.listingId,
          headline: r.headline,
          priceDisplay: r.priceDisplay,
          status: String(r.listingStatus),
          channel: String(r.channel),
        }
      : null,
    lastSale:
      sale && sale.price !== null && sale.price !== undefined
        ? { price: Number(sale.price), date: sale.date ? new Date(sale.date) : null }
        : null,
  };
}
