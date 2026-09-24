import { z } from 'zod';

/** Mirrors listing_channel in packages/db/schema.ts. */
export const listingChannelSchema = z.enum(['sale', 'rent', 'sold', 'leased']);
export type ListingChannel = z.infer<typeof listingChannelSchema>;

/** Mirrors listing_status. New listings start as draft — never auto-published. */
export const listingStatusSchema = z.enum([
  'draft',
  'pending',
  'live',
  'under_offer',
  'sold',
  'withdrawn',
]);
export type ListingStatus = z.infer<typeof listingStatusSchema>;

export const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'] as const;
export const auStateSchema = z.enum(AU_STATES);

const trimmed = (max: number) => z.string().trim().max(max);

/**
 * The physical place. Permanent, and shared by every listing ever written
 * against it — non-negotiable #1: property is not listing, and the two are
 * never merged.
 */
export const propertyDraftSchema = z.object({
  unit: trimmed(32).optional(),
  streetNumber: trimmed(32).optional(),
  street: trimmed(200).optional(),
  suburb: trimmed(120).min(1, 'Suburb is required'),
  state: auStateSchema.default('NSW'),
  postcode: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'Postcode must be 4 digits'),
  propertyType: trimmed(64).optional(),
  bedrooms: z.coerce.number().int().min(0).max(50).optional(),
  bathrooms: z.coerce.number().min(0).max(50).optional(),
  carSpaces: z.coerce.number().int().min(0).max(50).optional(),
  landAreaSqm: z.coerce.number().min(0).max(10_000_000).optional(),
  buildingAreaSqm: z.coerce.number().min(0).max(1_000_000).optional(),
  yearBuilt: z.coerce
    .number()
    .int()
    .min(1788, 'Year built looks too early for Australia')
    .max(new Date().getFullYear() + 5)
    .optional(),
  /**
   * The pin: where this dwelling actually is.
   *
   * A separate thing from the address above, not a derived form of it. The
   * address is what is printed on the ad and what a suburb search matches; the
   * pin is what a map shows and what a radius search measures. They usually
   * agree because the pin came from geocoding the address — but a geocoder can
   * be a street out on a new subdivision, and a battleaxe block behind another
   * house has an address that points at the wrong driveway. When they disagree,
   * the agent standing in the property is right and the geocoder is not, which
   * is what pinSource: 'manual' records.
   *
   * Optional on purpose: an address typed by hand still saves, and the server
   * geocodes it afterwards.
   */
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  placeId: trimmed(512).optional(),
  /**
   * Who put the pin where it is.
   *
   * 'manual' is a claim by a person and outranks the geocoder: nothing
   * re-geocodes over it, and `geo:backfill` skips it unless asked with --redo.
   */
  pinSource: z.enum(['google', 'manual']).optional(),
  /**
   * The geocoder's own one-line address for the pin.
   *
   * Stored alongside the parts, never instead of them and never parsed back
   * into them (non-negotiable #1 is about the parts; this is the receipt). It
   * is what lets an agent see which address was actually pinned, and it is the
   * only way a pin one street off is visible without a map.
   */
  formattedAddress: trimmed(400).optional(),
});

export type PropertyDraft = z.infer<typeof propertyDraftSchema>;

/**
 * The ad over that property.
 *
 * priceDisplay and priceFrom/priceTo are both carried, and both are stored —
 * non-negotiable #6. The string is what the public sees ("Offers over $1.2M",
 * "Contact agent"); the numbers are what search filters and medians use. The
 * string is never parsed at query time.
 */
export const listingDraftSchema = z
  .object({
    channel: listingChannelSchema,
    headline: trimmed(200).min(1, 'Headline is required'),
    description: trimmed(20_000).optional(),
    priceDisplay: trimmed(120).optional(),
    priceFrom: z.coerce.number().min(0).max(1_000_000_000).optional(),
    priceTo: z.coerce.number().min(0).max(1_000_000_000).optional(),
    rentPw: z.coerce.number().min(0).max(1_000_000).optional(),
    availableFrom: z.coerce.date().optional(),
    auctionDate: z.coerce.date().optional(),
  })
  .refine((v) => !(v.priceFrom && v.priceTo) || v.priceTo >= v.priceFrom, {
    message: 'Upper price cannot be below the lower price',
    path: ['priceTo'],
  })
  .refine((v) => v.channel !== 'rent' || v.rentPw !== undefined, {
    message: 'Weekly rent is required for a rental listing',
    path: ['rentPw'],
  });

export type ListingDraft = z.infer<typeof listingDraftSchema>;

export const createListingInputSchema = z.object({
  property: propertyDraftSchema,
  listing: listingDraftSchema,
  /**
   * Users to record in listing_agent. Empty means "just the creator", which
   * createListing fills in — a listing with no agent is unreachable for the
   * people who have to answer enquiries about it.
   */
  agentUserIds: z.array(z.string().uuid()).max(10).default([]),
});

export type CreateListingInput = z.infer<typeof createListingInputSchema>;

/**
 * An edit to an existing listing.
 *
 * The same two halves as creation, because an edit can move a listing to a
 * different address — a corrected street number is the common case — and the
 * property half has to be re-resolved when it does. Status is absent: it is
 * changed through setListingStatus alone, so an edit can never publish
 * something (non-negotiable #7).
 */
export const updateListingInputSchema = z.object({
  property: propertyDraftSchema,
  listing: listingDraftSchema,
  /** Omitted leaves the existing agents alone; [] is not a way to clear them. */
  agentUserIds: z.array(z.string().uuid()).max(10).optional(),
});

export type UpdateListingInput = z.infer<typeof updateListingInputSchema>;

/**
 * Everything the edit form needs, which is more than a table row shows.
 *
 * Kept apart from ListingRow on purpose: the list query runs on every console
 * page load for every listing, and description alone can be twenty thousand
 * characters. This one runs once, for one listing.
 *
 * It lives here rather than beside the query that builds it because the edit
 * form is a client component. Importing it from list-listings.ts pulled that
 * module's database client into the browser bundle, and the build failed on
 * `Can't resolve 'fs'` — a type is erased, but the module it comes from is
 * still resolved.
 */
export type ListingForEdit = {
  id: string;
  status: ListingStatus;
  propertyId: string;
  property: {
    unit: string | null;
    streetNumber: string | null;
    street: string | null;
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
    latitude: number | null;
    longitude: number | null;
    placeId: string | null;
    /** The geocoder's one-line address for the pin, or null if never geocoded. */
    formattedAddress: string | null;
    /** 'google' | 'manual' — a hand-placed pin must come back as one. */
    geocodeSource: string | null;
  };
  listing: {
    channel: ListingChannel;
    headline: string;
    description: string | null;
    priceDisplay: string | null;
    priceFrom: number | null;
    priceTo: number | null;
    rentPw: number | null;
  };
  /** Address as one line, for the page heading. */
  address: string;
};

export type ListingErrorCode =
  | 'forbidden'
  | 'invalid_draft'
  | 'not_found'
  /** The request is legal but the listing's current state refuses it. */
  | 'conflict'
  | 'unknown';

export class ListingError extends Error {
  readonly code: ListingErrorCode;
  readonly field?: string;

  constructor(code: ListingErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ListingError';
    this.code = code;
    this.field = field;
  }
}

/** Duck-typed so an error crossing a bundle boundary is still recognised. */
export function isListingError(err: unknown): err is ListingError {
  return (
    err instanceof ListingError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: string }).name === 'ListingError')
  );
}

export type ListingFieldErrors = Record<string, string>;

export function listingFieldErrors(issues: z.ZodIssue[]): ListingFieldErrors {
  const out: ListingFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.join('.');
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

/** Never hand a raw ZodError to the UI — it serialises as a JSON issue array. */
export function toListingError(err: unknown): ListingError {
  if (isListingError(err)) return err as ListingError;
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    return new ListingError(
      'invalid_draft',
      first?.message ?? 'Check the highlighted fields',
      first?.path.join('.'),
    );
  }
  return new ListingError(
    'unknown',
    err instanceof Error ? err.message : 'Could not save the listing',
  );
}

/**
 * A one-line address for lists and search results. Built from the parts
 * rather than stored, so it can never drift from them.
 */
export function formatAddress(p: {
  unit?: string | null;
  streetNumber?: string | null;
  street?: string | null;
  suburb: string;
  state: string;
  postcode: string;
}): string {
  const street = [p.streetNumber, p.street].filter(Boolean).join(' ').trim();
  const line = [p.unit ? `${p.unit}/` : '', street].join('').trim();
  return [line, p.suburb, `${p.state} ${p.postcode}`].filter(Boolean).join(', ');
}
