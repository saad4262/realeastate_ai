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

/**
 * What kind of dwelling this is. One list, and this is it.
 *
 * It was free text, and free text is the wrong shape for it: the public
 * search FILTERS on this column, and the filter dropdown is built by selecting
 * distinct values out of the live listings. So every typo became a permanent
 * new "type" that a buyer could pick and that matched exactly one listing.
 * The dropdown on the live site was offering "2jkads", "sfd" and "House" —
 * two of those are keyboard noise and the third is the same thing as "house"
 * with different capitalisation, which the filter treated as a separate kind
 * of building.
 *
 * A filterable dimension has to come from a fixed vocabulary or the filter
 * cannot work. Same reasoning as AU_STATES above, and the same rule as #8: one
 * list, in one place, that everything else derives from.
 *
 * Stored lower case so the column has one spelling; `propertyTypeLabel` is
 * what puts a capital on it for display.
 */
export const PROPERTY_TYPES = [
  'house',
  'apartment',
  'unit',
  'townhouse',
  'villa',
  'duplex',
  'studio',
  'acreage',
  'land',
  'rural',
  'other',
] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number];

/** Accepts "House" and "  house " alike; stores `house`. */
export const propertyTypeSchema = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .pipe(
    z.enum(PROPERTY_TYPES, {
      errorMap: () => ({ message: `Choose a property type from the list` }),
    }),
  );

/** Display form. The column holds `townhouse`; a buyer should read "Townhouse". */
export function propertyTypeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * How a result set is ordered. Another closed vocabulary, so it lives here.
 *
 * It was declared in ./search-listings.ts, which imports `@repo/db`. Six call
 * sites wanted these four strings and were pulling postgres.js in to get them
 * — including two zod schemas and the chat's tool definition. This module
 * imports nothing but zod, which is what a vocabulary should cost.
 */
export const SORT_OPTIONS = ['relevance', 'newest', 'price_asc', 'price_desc'] as const;
export type SearchSort = (typeof SORT_OPTIONS)[number];
export const sortSchema = z.enum(SORT_OPTIONS);

const trimmed = (max: number) => z.string().trim().max(max);

/**
 * How many of a thing a dwelling can plausibly have.
 *
 * Was 50, which is not a validation so much as a very large number. A live
 * listing in this database claimed 23 bedrooms, 32 bathrooms and 32 car
 * spaces, and every layer accepted it: the form, the schema, the database and
 * the public search. 20 is still generous — it clears any share house or
 * boarding house — while refusing what is obviously a keyboard rather than a
 * building. Raise it when a real property needs it, not in case one might.
 */
const MAX_ROOMS = 20;
const roomCount = (label: string) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_ROOMS, `${label} looks wrong — more than ${MAX_ROOMS} needs checking`);

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
  propertyType: propertyTypeSchema.optional(),
  bedrooms: roomCount('Bedrooms').optional(),
  bathrooms: z.coerce
    .number()
    .min(0)
    .max(MAX_ROOMS, `Bathrooms looks wrong — more than ${MAX_ROOMS} needs checking`)
    .optional(),
  carSpaces: roomCount('Car spaces').optional(),
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
 * A headline is whatever the agency wrote.
 *
 * There used to be two shape rules here — at least ten characters, and at
 * least two words — added because "dfs", "dfsdsf" and "jdsfjdfjl" were live
 * on the public site. They were removed deliberately, at the owner's
 * request: the people filling this form are the agency whose name is on the
 * listing, and a portal that argues with them about their own copy costs
 * more in refused saves than it ever saved in junk.
 *
 * The 200 stays, and it is not a taste rule. It is what the card, the
 * search result and the email subject are laid out for, and what stops a
 * paste of a whole brochure travelling with every row of every result page.
 * `min(1)` stays too — the column is the title of the card, and a card with
 * no title renders as a blank line rather than as a choice somebody made.
 *
 * If the junk comes back, the answer is a REVIEW step, not a regex: refusing
 * the save only moves the problem to whoever is watching the form.
 */
const headlineSchema = trimmed(200).min(1, 'Headline is required');

/**
 * Price copy, not a number.
 *
 * priceDisplay and priceFrom/priceTo are two different things and #6 keeps
 * them that way: the string is what a buyer reads, the numbers are what
 * search filters on, and the string is never parsed back into a number. That
 * only holds while the string is actually copy. Three live listings here had
 * priceDisplay "23443342", "332432322" and "9320334343324" — bare digits,
 * shown to the public verbatim, agreeing with nothing. One of them displayed
 * a figure of twenty-three million while its searchable range said $34,443,
 * so a buyer filtering under $50,000 was shown a listing that reads as $23M.
 *
 * So: a display price must contain a letter or a dollar sign. "$720,000",
 * "Offers over $700,000", "Contact agent" and "Auction 12 April" all pass; a
 * naked run of digits does not, and the message says where the number goes.
 *
 * This is a shape check. It does not parse the string and it does not compare
 * it to priceFrom/priceTo — doing that reliably across "$1.45m", "1,450,000"
 * and "high $1m's" is its own project, and getting it wrong would refuse to
 * save a legitimate listing. See ARCHITECTURE.md, "Known gaps".
 */
const priceDisplaySchema = trimmed(120).refine((v) => v === '' || /[A-Za-z$]/.test(v), {
  message:
    'Write the price as a buyer should read it — "$720,000", "Offers over $700,000" or "Contact agent". The searchable figures go in the price range fields below.',
});

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
    headline: headlineSchema,
    /**
     * Optional — plenty of listings have no body copy and that is fine. But
     * "asd" is not body copy, and it was sitting on a live listing under the
     * heading "About this property". Same shape of rule as the headline: if
     * there IS a description it has to be writing, and the floor is low enough
     * that one real sentence clears it.
     */
    /**
     * Optional, and unjudged. Same decision as the headline above: the
     * "at least a sentence" floor is gone, so "asd" saves if that is what
     * the agency meant to write. 20,000 is the bound that remains, because
     * this column is read whole by the edit form and by the public page.
     */
    description: trimmed(20_000).optional(),
    priceDisplay: priceDisplaySchema.optional(),
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
  })
  /**
   * A sale listing has to say something about price.
   *
   * All three were optional, so "for sale, no price of any kind" saved
   * cleanly — and then showed as "Contact agent" on the public card whether
   * that was the intent or whether the agent simply never filled it in. Any
   * one of the three satisfies this: "Contact agent" typed on purpose is a
   * price statement, an empty form is not.
   */
  .refine(
    (v) =>
      v.channel !== 'sale' ||
      Boolean(v.priceDisplay) ||
      v.priceFrom !== undefined ||
      v.priceTo !== undefined,
    {
      message: 'A sale listing needs a price — a display price, a range, or both',
      path: ['priceDisplay'],
    },
  );

export type ListingDraft = z.infer<typeof listingDraftSchema>;

/**
 * What an agency has to say to record a sale.
 *
 * Deliberately its OWN schema rather than two more optional fields on
 * `listingDraftSchema`. That schema is replayed by `pnpm smoke` over every
 * existing `status = 'live'` row to prove the live site is servable, so a field
 * that is required for a sale and meaningless for a live ad would turn that
 * check red on data that is perfectly correct. A sale is a transition, not an
 * edit — it arrives through setListingStatus, next to the status it belongs to.
 *
 * Both fields are required together. `status = 'sold'` with no price is the
 * state the public timeline cannot render and the one `pnpm smoke` now refuses
 * to find in the database.
 */
export const soldDetailsSchema = z.object({
  /**
   * What it actually sold for. The agency's own figure, stored, never derived —
   * non-negotiable #4. Zero is not a sale, so the floor is above it.
   */
  soldPrice: z.coerce.number().min(1, 'Enter what the property sold for').max(1_000_000_000),
  /**
   * When. A future date is a contract, not a sale, and the timeline orders on
   * this column — one mistyped year puts a 2019 sale at the top of the history
   * of every address that agency has ever sold.
   */
  soldDate: z.coerce
    .date()
    .refine((d) => d.getTime() <= Date.now(), { message: 'A sale cannot be dated in the future' }),
});

export type SoldDetails = z.infer<typeof soldDetailsSchema>;

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
