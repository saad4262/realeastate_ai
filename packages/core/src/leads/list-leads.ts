import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { lead, property, type Db } from '@repo/db';
import { can, type Actor } from '../permissions';
import { formatAddress } from '../listings/listing-schema';

export type LeadKind = 'enquiry' | 'inspection' | 'appraisal' | 'offer';
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'closed';

/** One row of the agency's inbox. */
export type LeadRow = {
  id: string;
  kind: LeadKind;
  status: LeadStatus;
  name: string;
  email: string;
  phone: string | null;
  message: string | null;
  /** Dollars, on an offer. Null on every other kind. */
  offerAmount: number | null;
  /**
   * The address, always. A lead is anchored to the property (docs/adr/0012),
   * which is what lets an enquiry and an offer sit in one table and one list —
   * an offer has no listing to take an address from.
   */
  propertyId: string;
  address: string;
  suburb: string;
  state: string;
  postcode: string;
  /** Which ad brought it in, if an ad did. Null on an offer. */
  listingId: string | null;
  createdAt: Date;
};

/** The tab counts, over the whole inbox rather than the page. */
export type LeadCounts = {
  total: number;
  /** Unactioned, any kind. What the nav badge shows. */
  unread: number;
  /** Private offers the actor is allowed to see. Zero when they are not. */
  offers: number;
};

export type LeadPage = {
  rows: LeadRow[];
  counts: LeadCounts;
  /**
   * Whether this actor may see private offers at all.
   *
   * Returned rather than recomputed in the UI: the screen has to know whether
   * to draw the Offers tab, and a second role check in a component is the thing
   * non-negotiable #2 forbids. The decision is made once, by can().
   */
  maySeeOffers: boolean;
};

export type ListLeadsOptions = {
  /** Narrow to one kind — the tabs. Omit for everything visible. */
  kind?: LeadKind;
  limit?: number;
  offset?: number;
};

export class LeadError extends Error {
  readonly code: 'forbidden';
  constructor(message: string) {
    super(message);
    this.name = 'LeadError';
    this.code = 'forbidden';
  }
}

const FORBIDDEN = new LeadError('You do not have permission to view this inbox');

/**
 * One page of the agency's lead inbox, plus the counts for the whole of it.
 *
 * ## Two permissions, and why the second one filters rows
 *
 * `lead:read` opens the inbox. `lead:read_offer` is narrower — an offer is a
 * named person's financial intent about somebody's home, and only the people
 * who run the agency are told about one. Both answers come from `can()`; this
 * function turns the second into a WHERE clause rather than checking a role
 * itself, which is what keeps the rule in permissions.ts (#2).
 *
 * An actor without `lead:read_offer` does not see offers filtered out of their
 * counts — they see an inbox in which offers never existed. A visible "3
 * hidden" would tell an assistant that three offers arrived, which is most of
 * what the restriction exists to withhold.
 *
 * ## One statement
 *
 * The counts are window functions over the same scan, not a second SELECT —
 * the same reasoning as `listAgencyListingsPage`, and `query-count.test.ts`
 * holds it to one query. `filter (where ...)` evaluates before LIMIT, so the
 * tab counts stay inbox-wide however small the page is.
 */
export async function listAgencyLeads(
  db: Db,
  actor: Actor,
  opts: ListLeadsOptions = {},
): Promise<LeadPage> {
  if (!actor.agencyId) throw FORBIDDEN;

  const resource = { type: 'lead', agencyId: actor.agencyId };
  if (!can(actor, 'lead:read', resource)) throw FORBIDDEN;

  const maySeeOffers = can(actor, 'lead:read_offer', resource);

  // Asking for the offers tab without the permission is a refusal, not an empty
  // list: an empty page would read as "no offers yet" to somebody who simply
  // may not see them, and they would stop looking.
  if (opts.kind === 'offer' && !maySeeOffers) throw FORBIDDEN;

  const filters = [eq(lead.agencyId, actor.agencyId)];
  if (!maySeeOffers) filters.push(ne(lead.kind, 'offer'));
  if (opts.kind) filters.push(eq(lead.kind, opts.kind));

  const rows = await db
    .select({
      id: lead.id,
      kind: lead.kind,
      status: lead.status,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      message: lead.message,
      offerAmount: lead.offerAmount,
      propertyId: lead.propertyId,
      listingId: lead.listingId,
      createdAt: lead.createdAt,
      unit: property.unit,
      streetNumber: property.streetNumber,
      street: property.street,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
      totalCount: sql<number>`count(*) over()`,
      unreadCount: sql<number>`count(*) filter (where ${lead.status} = 'new') over()`,
      offerCount: sql<number>`count(*) filter (where ${lead.kind} = 'offer') over()`,
    })
    .from(lead)
    .innerJoin(property, eq(property.id, lead.propertyId))
    .where(and(...filters))
    // Newest first, with a unique tiebreaker so a page boundary inside a group
    // sharing a timestamp does not repeat one row and skip another.
    .orderBy(desc(lead.createdAt), desc(lead.id))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  const first = rows[0];

  return {
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind as LeadKind,
      status: r.status as LeadStatus,
      name: r.name,
      email: r.email,
      phone: r.phone,
      message: r.message,
      // numeric arrives from the driver as a string, and 0 is not the same as
      // "this lead is not an offer".
      offerAmount: r.offerAmount === null ? null : Number(r.offerAmount),
      propertyId: r.propertyId,
      address: formatAddress(r),
      suburb: r.suburb,
      state: r.state,
      postcode: r.postcode,
      listingId: r.listingId,
      createdAt: r.createdAt,
    })),
    counts: {
      /**
       * Number(), and it is not defensive padding. count() returns bigint and
       * the driver hands bigint back as a STRING — so these arrive as "3" while
       * the type says number, which is a lie TypeScript cannot catch. The
       * console header read "Live 31" the last time this was missed.
       *
       * A count is only present when a row is: window functions have nothing to
       * project over an empty result, so an empty inbox is zero, not undefined.
       */
      total: Number(first?.totalCount ?? 0),
      unread: Number(first?.unreadCount ?? 0),
      offers: Number(first?.offerCount ?? 0),
    },
    maySeeOffers,
  };
}
