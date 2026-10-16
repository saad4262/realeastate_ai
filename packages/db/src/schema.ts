import { desc, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from 'drizzle-orm/pg-core';

/**
 * Postgres full-text search vector (ADR 0031). Only ever a GENERATED column:
 * Postgres keeps it current on every insert and update; nothing writes it.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const membershipRoleEnum = pgEnum('membership_role', [
  'owner',
  'admin',
  'agent',
  'assistant',
  'property_manager',
  'read_only',
]);

export const membershipStatusEnum = pgEnum('membership_status', [
  'invited',
  'active',
  'suspended',
]);

export const listingChannelEnum = pgEnum('listing_channel', [
  'sale',
  'rent',
  'sold',
  'leased',
]);

export const listingStatusEnum = pgEnum('listing_status', [
  'draft',
  'pending',
  'live',
  'under_offer',
  'sold',
  'withdrawn',
]);

export const listingSourceEnum = pgEnum('listing_source', ['portal', 'reaxml', 'api']);

export const listingAgentRoleEnum = pgEnum('listing_agent_role', [
  'lead',
  'co',
  'property_manager',
]);

export const mediaKindEnum = pgEnum('media_kind', ['photo', 'floorplan', 'video', 'tour']);

export const inspectionKindEnum = pgEnum('inspection_kind', ['open', 'private', 'auction']);

/**
 * `offer` is a private offer on a property that is not on the market — it
 * arrives with an amount and no listing. See docs/adr/0012.
 */
export const leadKindEnum = pgEnum('lead_kind', [
  'enquiry',
  'inspection',
  'appraisal',
  'offer',
]);

export const leadStatusEnum = pgEnum('lead_status', [
  'new',
  'contacted',
  'qualified',
  'closed',
]);

export const agencyStatusEnum = pgEnum('agency_status', ['active', 'suspended', 'trial']);

/** App user — PK matches Supabase auth.users.id */
/** Mirror of auth.users — id is always auth.users.id (ADR 0004). */
export const user = pgTable('user', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  phone: text('phone'),
  avatarUrl: text('avatar_url'),
  /**
   * The address this person has PROVED they receive mail at, by opening a link
   * sent to it (docs/adr/0016). Not `email`: sign-up does not confirm an
   * address in this project, so `email` is only what somebody typed. A buyer's
   * conversations are matched on this, and only while it still equals `email`
   * — changing the sign-in address leaves it stale, and stale matches nothing.
   */
  verifiedEmail: text('verified_email'),
  ...timestamps,
});

export const agency = pgTable('agency', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: varchar('slug', { length: 120 }).notNull().unique(),
  abn: varchar('abn', { length: 32 }),
  logoUrl: text('logo_url'),
  brandColor: varchar('brand_color', { length: 16 }),
  plan: varchar('plan', { length: 64 }).default('trial'),
  status: agencyStatusEnum('status').notNull().default('trial'),
  /**
   * The agency's own clock (ADR 0027): "today", "this week" and "this month"
   * on a dashboard mean the same for everyone looking at one screen.
   */
  timeZone: text('time_zone').notNull().default('Australia/Sydney'),
  /**
   * ADR 0026, decided Q3: whether members other than owners/admins may send
   * from the agency's connected Gmail. An owner/admin switch, on by default.
   */
  membersMayUseAgencyGmail: boolean('members_may_use_agency_gmail').notNull().default(true),
  ...timestamps,
});

export const office = pgTable('office', {
  id: uuid('id').primaryKey().defaultRandom(),
  agencyId: uuid('agency_id')
    .notNull()
    .references(() => agency.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: varchar('slug', { length: 120 }).notNull(),
  address: text('address'),
  phone: text('phone'),
  ...timestamps,
});

export const team = pgTable('team', {
  id: uuid('id').primaryKey().defaultRandom(),
  agencyId: uuid('agency_id')
    .notNull()
    .references(() => agency.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  ...timestamps,
});

export const teamMember = pgTable(
  'team_member',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    roleInTeam: varchar('role_in_team', { length: 64 }),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const membership = pgTable(
  'membership',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    officeId: uuid('office_id').references(() => office.id, { onDelete: 'set null' }),
    role: membershipRoleEnum('role').notNull(),
    status: membershipStatusEnum('status').notNull().default('active'),
    invitedBy: uuid('invited_by').references(() => user.id, { onDelete: 'set null' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow(),
    /** Offboarding (ADR 0030 §5): when and by whom they were removed. Restorable for 30 days. */
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: uuid('removed_by').references(() => user.id, { onDelete: 'set null' }),
    /** What the removal did (counts, where the work went, what could not be undone) — for the admin. */
    removalReport: jsonb('removal_report'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('membership_user_agency_idx').on(t.userId, t.agencyId),
    // ADR 0030, decided Q4: one ACTIVE agency per person.
    uniqueIndex('membership_one_active_idx').on(t.userId).where(sql`status = 'active'`),
  ],
);

export const agentInviteStatusEnum = pgEnum('agent_invite_status', [
  'pending',
  'accepted',
  'revoked',
  'expired',
]);

export const agentProfile = pgTable('agent_profile', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' })
    .unique(),
  slug: varchar('slug', { length: 160 }).notNull().unique(),
  /**
   * Legal names as they appear on the Fair Trading licence, kept apart from
   * display_name. The onboarding wizard asks for both and they were being
   * folded into user.name, which cannot be taken back apart.
   */
  firstName: text('first_name'),
  lastName: text('last_name'),
  displayName: text('display_name'),
  bio: text('bio'),
  /**
   * An externally hosted portrait — whatever URL the agency pasted in.
   *
   * Kept because rows already carry one and because an agency may host its
   * headshots anywhere. New uploads do NOT land here; they land in photo_key.
   */
  photoUrl: text('photo_url'),
  /**
   * A key in the media bucket, never a URL.
   *
   * Same rule as `media.storage_key`, for the same reason: the row must not
   * know which host is serving the file, or moving off Supabase Storage means
   * rewriting every row instead of one resolver. `mediaUrl()` in
   * packages/core/src/media is that resolver.
   *
   * Read in preference to photo_url when both are set — an upload is a
   * deliberate act and beats a link someone pasted once.
   */
  photoKey: text('photo_key'),
  languages: text('languages').array(),
  specialties: text('specialties').array(),
  yearsExperience: integer('years_experience'),
  licenceNumber: varchar('licence_number', { length: 64 }),
  licenceClass: varchar('licence_class', { length: 64 }),
  licenceExpiry: timestamp('licence_expiry', { withTimezone: true }),
  territorySuburbs: text('territory_suburbs').array(),
  territoryRadiusKm: numeric('territory_radius_km', { precision: 5, scale: 1 }),
  commissionTier: varchar('commission_tier', { length: 32 }),
  commissionSplitAgent: integer('commission_split_agent'),
  commissionSplitAgency: integer('commission_split_agency'),
  operationalRole: varchar('operational_role', { length: 64 }),
  permissionFlags: jsonb('permission_flags').$type<Record<string, boolean>>(),
  public: boolean('public').notNull().default(false),
  ...timestamps,
});

/** Pending Add-Agent onboarding invite (claim on signup or when service-role provisions auth). */
export const agentInvite = pgTable('agent_invite', {
  id: uuid('id').primaryKey().defaultRandom(),
  agencyId: uuid('agency_id')
    .notNull()
    .references(() => agency.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  token: varchar('token', { length: 64 }).notNull().unique(),
  status: agentInviteStatusEnum('status').notNull().default('pending'),
  draft: jsonb('draft').notNull(),
  invitedBy: uuid('invited_by').references(() => user.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
  membershipId: uuid('membership_id').references(() => membership.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ...timestamps,
});

/** Physical place — permanent. Never merge with listing. */
export const property = pgTable('property', {
  id: uuid('id').primaryKey().defaultRandom(),
  gnafPid: varchar('gnaf_pid', { length: 64 }),
  unit: varchar('unit', { length: 32 }),
  streetNumber: varchar('street_number', { length: 32 }),
  street: text('street'),
  suburb: text('suburb').notNull(),
  state: varchar('state', { length: 8 }).notNull().default('NSW'),
  postcode: varchar('postcode', { length: 8 }).notNull(),
  /**
   * WGS84, six decimal places — about 10 cm, far finer than a street address
   * is ever known to.
   *
   * The PostGIS column that radius search actually reads is `geom`, a STORED
   * generated column derived from this pair. It is deliberately absent from
   * this schema: Drizzle has no geography type, and a hand-modelled duplicate
   * would be a second place for the location to live. Nothing writes geom;
   * Postgres keeps it in step, and ST_DWithin reads it through raw SQL.
   */
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  /** The provider's own id for this place, so a re-geocode is a cache hit. */
  placeId: text('place_id'),
  /**
   * The geocoder's own one-line address for the pin — "12 Campbell Parade,
   * Bondi Beach NSW 2026, Australia".
   *
   * Not a duplicate of the parts above and never parsed back into them. The
   * parts are what this platform matches and searches on; this is the exact
   * string the provider pinned, kept so an agent can see what was located and
   * so a wrong pin is visible without opening a map. Null until something
   * geocodes the row.
   */
  formattedAddress: text('formatted_address'),
  geocodedAt: timestamp('geocoded_at', { withTimezone: true }),
  /** 'google' | 'manual' — a hand-placed pin must survive a bulk re-geocode. */
  geocodeSource: varchar('geocode_source', { length: 32 }),
  propertyType: varchar('property_type', { length: 64 }),
  bedrooms: integer('bedrooms'),
  bathrooms: numeric('bathrooms', { precision: 3, scale: 1 }),
  carSpaces: integer('car_spaces'),
  landAreaSqm: numeric('land_area_sqm', { precision: 12, scale: 2 }),
  buildingAreaSqm: numeric('building_area_sqm', { precision: 12, scale: 2 }),
  yearBuilt: integer('year_built'),
  suburbId: uuid('suburb_id'),
  lgaId: uuid('lga_id'),
  schoolCatchmentIds: text('school_catchment_ids').array(),
  ...timestamps,
});

/**
 * Geocoder results, kept so the same search is never paid for twice.
 *
 * Every provider bills per lookup and rate-limits on top, and a consumer
 * typing "bondi" issues one request per keystroke. The key is the normalised
 * query, so "Bondi Beach", " bondi beach " and "BONDI BEACH" are one row.
 *
 * Nothing here is authoritative: it is a cache of somebody else's answer, and
 * deleting the whole table only costs money, never correctness.
 */
export const placeCache = pgTable(
  'place_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** lower(trim(query)), or `place:<providerPlaceId>` for a detail lookup. */
    lookupKey: text('lookup_key').notNull(),
    provider: varchar('provider', { length: 32 }).notNull().default('google'),
    placeId: text('place_id'),
    /** What to show the user back — "Bondi Beach NSW 2026, Australia". */
    formatted: text('formatted').notNull(),
    /**
     * The street half of the answer.
     *
     * Held because a cache that returns less than the provider did is not a
     * cache — the second agent to pick the same address got a row with no
     * street number and watched the form blank the fields the first agent saw
     * filled.
     */
    unit: varchar('unit', { length: 32 }),
    streetNumber: varchar('street_number', { length: 32 }),
    street: text('street'),
    suburb: text('suburb'),
    state: varchar('state', { length: 8 }),
    postcode: varchar('postcode', { length: 8 }),
    latitude: numeric('latitude', { precision: 9, scale: 6 }).notNull(),
    longitude: numeric('longitude', { precision: 9, scale: 6 }).notNull(),
    /** 'address' | 'locality' | 'postcode' | 'region' — a suburb search and a
     * street search want different default radii. */
    kind: varchar('kind', { length: 32 }).notNull().default('address'),
    ...timestamps,
  },
  (t) => [uniqueIndex('place_cache_lookup_key_idx').on(t.lookupKey)],
);

/** Ad over a property — no agent_id column; use listing_agent. */
export const listing = pgTable(
  'listing',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => property.id, { onDelete: 'restrict' }),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'restrict' }),
    officeId: uuid('office_id').references(() => office.id, { onDelete: 'set null' }),
    teamId: uuid('team_id').references(() => team.id, { onDelete: 'set null' }),
    channel: listingChannelEnum('channel').notNull(),
    status: listingStatusEnum('status').notNull().default('draft'),
    priceFrom: numeric('price_from', { precision: 14, scale: 2 }),
    priceTo: numeric('price_to', { precision: 14, scale: 2 }),
    priceDisplay: text('price_display'),
    rentPw: numeric('rent_pw', { precision: 12, scale: 2 }),
    availableFrom: timestamp('available_from', { withTimezone: true }),
    headline: text('headline'),
    description: text('description'),
    soldPrice: numeric('sold_price', { precision: 14, scale: 2 }),
    soldDate: timestamp('sold_date', { withTimezone: true }),
    /**
     * The agency's own id for this listing, from its old system (ADR 0029) —
     * so a second import of the same file updates instead of duplicating.
     * Unique per agency when set.
     */
    externalId: text('external_id'),
    /** Flagged by an offboarding (ADR 0030 §5): its person left and it waits in the "Needs an owner" queue. */
    needsOwnerAt: timestamp('needs_owner_at', { withTimezone: true }),
    auctionDate: timestamp('auction_date', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    source: listingSourceEnum('source').notNull().default('portal'),
    externalRef: varchar('external_ref', { length: 128 }),
    ...timestamps,
  },
  (t) => [
    /**
     * Postgres does not index a foreign key column, and every read that asks
     * "what has happened at this address" filters on this one — the public
     * timeline on each listing page, and both halves of the off-market gate.
     * It was a sequential scan of the whole table each time.
     */
    index('listing_property_idx').on(t.propertyId),
    /** Figures over an agency's listings by status and sale date (ADR 0036 P7): sales in a range, active now. */
    index('listing_agency_status_sold_idx').on(t.agencyId, t.status, t.soldDate),
  ],
);

export const listingAgent = pgTable(
  'listing_agent',
  {
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listing.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    role: listingAgentRoleEnum('role').notNull().default('lead'),
    displayOrder: integer('display_order').notNull().default(0),
    snapshotName: text('snapshot_name').notNull(),
    snapshotPhone: text('snapshot_phone').notNull(),
    snapshotEmail: text('snapshot_email').notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.listingId, t.userId] }),
    /**
     * One lead agent per listing (ADR 0036 P4): at most one row at display
     * order 0. Migration 0042 renumbers existing duplicates (oldest keeps 0)
     * before creating it. Figures read the lead agent as the LOWEST order
     * (`leadAgentIdSql`), since offboarding can leave nobody at 0.
     */
    uniqueIndex('listing_agent_lead_idx').on(t.listingId).where(sql`display_order = 0`),
  ],
);

export const media = pgTable('media', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id')
    .notNull()
    .references(() => listing.id, { onDelete: 'cascade' }),
  kind: mediaKindEnum('kind').notNull().default('photo'),
  storageKey: text('storage_key').notNull(),
  width: integer('width'),
  height: integer('height'),
  isMain: boolean('is_main').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  caption: text('caption'),
  aiTags: jsonb('ai_tags'),
  aiQualityScore: numeric('ai_quality_score', { precision: 4, scale: 2 }),
  ...timestamps,
});

export const inspection = pgTable('inspection', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id')
    .notNull()
    .references(() => listing.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  kind: inspectionKindEnum('kind').notNull().default('open'),
  ...timestamps,
});

/**
 * Somebody wanting to talk to an agency about an address.
 *
 * Anchored to the PROPERTY, not to the ad. An enquiry arrives through a live
 * listing and a private offer arrives with no listing at all — the address is
 * the only thing both have — so `property_id` is the required key and
 * `listing_id` records which ad brought it in, if an ad did. See docs/adr/0012.
 *
 * `property_id` is `restrict` while `agency_id` is `cascade`, and the asymmetry
 * is deliberate: deleting an agency is a decision about that agency's own data,
 * but a property outlives every ad written against it (#1) and so does a third
 * party's offer on it. `listing_id` stays `cascade` — losing "which ad" when the
 * ad is deleted is correct, and it is why an offer must never hang off one.
 */
export const lead = pgTable(
  'lead',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => property.id, { onDelete: 'restrict' }),
    /** Null for an approach that came through no advertisement. */
    listingId: uuid('listing_id').references(() => listing.id, { onDelete: 'cascade' }),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    message: text('message'),
    kind: leadKindEnum('kind').notNull().default('enquiry'),
    status: leadStatusEnum('status').notNull().default('new'),
    /**
     * Where it came from (ADR 0040): `website` (an enquiry or offer from the
     * public site — every lead before this column) or `manual` (recorded by a
     * member in the console or through the assistant).
     */
    source: varchar('source', { length: 16 }).notNull().default('website'),
    /**
     * What the visitor offered, on a lead that is an offer.
     *
     * Their own figure, stored as they typed it — never computed, estimated or
     * compared to anything (#4). Null on every other kind of lead; the rule that
     * an offer carries one lives in createPrivateOffer, not in a CHECK, because
     * a constraint naming 'offer' cannot be added in the same migration that
     * adds the enum value.
     */
    offerAmount: numeric('offer_amount', { precision: 14, scale: 2 }),
    assignedTo: uuid('assigned_to').references(() => user.id, { onDelete: 'set null' }),
    /** Flagged by an offboarding (ADR 0030 §5): its person left and it waits in the "Needs an owner" queue. */
    needsOwnerAt: timestamp('needs_owner_at', { withTimezone: true }),
    /**
     * The person behind it (ADR 0018). Set by the `lead` insert trigger through
     * `public.contact_upsert`, matched on email; nullable only so the column
     * could be added before the backfill.
     */
    contactId: uuid('contact_id').references((): AnyPgColumn => contact.id, { onDelete: 'set null' }),
    aiSummary: text('ai_summary'),
    aiIntent: text('ai_intent'),
    aiQualification: jsonb('ai_qualification'),
    /** Full-text of the enquiry message (ADR 0031). Generated; never written. */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(sql`to_tsvector('english', coalesce(message, ''))`),
    ...timestamps,
  },
  (t) => [
    index('lead_search_idx').using('gin', t.searchTsv),
    /** The agency inbox: their leads, newest first. There was no index at all. */
    index('lead_agency_created_idx').on(t.agencyId, desc(t.createdAt)),
    /** Every approach ever made about one address, which is the point of #1. */
    index('lead_property_idx').on(t.propertyId),
    index('lead_contact_idx').on(t.contactId),
  ],
);

/** Which way a message went: from outside to the agency, or from the agency out. */
export const mailDirectionEnum = pgEnum('mail_direction', ['in', 'out']);

/**
 * Where a message was written: `console` — an agent in the inbox; `email` — an
 * agent's reply from their own mail client, relayed; `website` — the buyer,
 * answering from their messages page instead of their mail app.
 */
export const mailChannelEnum = pgEnum('mail_channel', ['console', 'email', 'website']);

/** `received` is every inbound row. The other three are an outbound send's life. */
export const mailStatusEnum = pgEnum('mail_status', ['received', 'queued', 'sent', 'failed']);

/**
 * One email conversation with somebody outside the agency. See docs/adr/0016.
 *
 * Every lead has exactly one, made by a trigger on `lead` insert — so neither
 * lead write path had to change, and a lead written by a script or the seed
 * gets its conversation too. A thread with no lead is mail that arrived at the
 * agency's own address about nothing we know of.
 *
 * Status and assignee are NOT here. On a lead thread they are the lead's, read
 * through the join: two columns saying who owns one conversation is two
 * answers to one question.
 */
export const mailThread = pgTable(
  'mail_thread',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    /** Unique: one conversation per lead. Null for mail to the agency's own address. */
    leadId: uuid('lead_id')
      .unique()
      .references(() => lead.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    /** Lower-cased on write, so matching a buyer's sign-in email is an equality. */
    contactEmail: text('contact_email').notNull(),
    contactName: text('contact_name'),
    /**
     * The contact this conversation is with (ADR 0018) — the lead's, copied by
     * the thread trigger, or matched on `contact_email` for mail to the
     * agency's own address. What lets such a thread be read by the contact's
     * agent rather than by admins only.
     */
    contactId: uuid('contact_id').references((): AnyPgColumn => contact.id, { onDelete: 'set null' }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The last time somebody OUTSIDE wrote. Unread is "this is newer than when
     * you last opened it" — so your own reply never marks a thread unread for you.
     */
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    index('mail_thread_agency_idx').on(t.agencyId, desc(t.lastMessageAt)),
    index('mail_thread_contact_idx').on(t.contactEmail),
    index('mail_thread_contact_id_idx').on(t.contactId),
  ],
);

/**
 * One email, in or out.
 *
 * The opening message of a lead thread is NOT a row here — it is `lead.message`,
 * rendered first. Copying it would be a second record of what the buyer wrote.
 *
 * `html` is stored as received and is NEVER put into a page as markup: the
 * console renders it in a sandboxed iframe (ADR 0016 §5).
 */
export const mailMessage = pgTable(
  'mail_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    /** Denormalised so the RLS policy is readable without a join. */
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    direction: mailDirectionEnum('direction').notNull(),
    /** Only on `out`: written in the console, or relayed from an agent's own mail. */
    channel: mailChannelEnum('channel'),
    status: mailStatusEnum('status').notNull(),
    fromEmail: text('from_email').notNull(),
    fromName: text('from_name'),
    toEmails: text('to_emails').array().notNull().default(sql`'{}'::text[]`),
    subject: text('subject').notNull(),
    /** Plain text, always present. What lists, previews and relays use. */
    text: text('text').notNull().default(''),
    /** Inbound only, as received. Sandboxed on display, never trusted. */
    html: text('html'),
    /** The member who wrote it, on an outbound message. */
    sentBy: uuid('sent_by').references(() => user.id, { onDelete: 'set null' }),
    /**
     * Resend's id. Unique, which is what makes a webhook delivered twice a
     * no-op rather than a duplicated message. Postgres treats NULLs as
     * distinct, so a queued send with no id yet does not collide.
     */
    providerId: text('provider_id').unique(),
    /**
     * The RFC 5322 Message-ID of a received message, so our answer can carry
     * `In-Reply-To` and land under it in the buyer's client. Never used to
     * ROUTE mail: a header anybody can write is not a key to a conversation —
     * only the signed Reply-To is.
     */
    rfcMessageId: text('rfc_message_id'),
    /** `[{ filename, contentType, size }]` — listed, not stored (ADR 0016, Not done). */
    attachments: jsonb('attachments').notNull().default(sql`'[]'::jsonb`),
    /** Why a send failed. Never shown to the buyer. */
    error: text('error'),
    /**
     * What sort of email the platform composed, when it composed it — e.g.
     * `appointment_invitation`. Null for a person's own reply in a
     * conversation. Templated mail counts against the daily sending limits
     * (`email/limits.ts`); a reply to a buyer never does.
     */
    kind: varchar('kind', { length: 32 }),
    /**
     * How it actually left (ADR 0026): `resend` (the platform sender) or
     * `gmail` (a connected Gmail, send-only). Null until a send was tried,
     * and on rows from before Gmail existed (all platform).
     */
    sentVia: varchar('sent_via', { length: 16 }),
    /** The Gmail account it went (or tried to go) through. Gone with the connection. */
    senderAccountId: uuid('sender_account_id').references(() => integrationAccount.id, { onDelete: 'set null' }),
    /**
     * A delivery's claim (ADR 0039 Phase 1): set, guarded, before the provider is
     * called, so two deliveries of one queued row never both send. A claim older
     * than the stale window belongs to a delivery that died; the next one may
     * take it, reusing the same provider idempotency key.
     */
    sendStartedAt: timestamp('send_started_at', { withTimezone: true }),
    /** Which try this is: a person's Retry is a new try (a new idempotency key); a crash recovery is not. */
    sendAttempt: integer('send_attempt').notNull().default(0),
    /** Full-text of subject + body (ADR 0031). Generated; never written. */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(sql`to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(text, ''))`),
    ...timestamps,
  },
  (t) => [
    index('mail_message_thread_idx').on(t.threadId, t.createdAt),
    index('mail_message_search_idx').using('gin', t.searchTsv),
    /** Figures over an agency's mail in a range (ADR 0036 P7). */
    index('mail_message_agency_created_idx').on(t.agencyId, t.createdAt),
  ],
);

/** When each member last opened each thread. Unread is per person, not per agency. */
export const mailRead = pgTable(
  'mail_read',
  {
    threadId: uuid('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.userId] })],
);

/**
 * When a BUYER last opened one of their conversations on the website
 * (ADR 0035 §2). Separate from `mail_read`, which is the agency's members.
 */
export const mailCustomerRead = pgTable(
  'mail_customer_read',
  {
    threadId: uuid('thread_id')
      .notNull()
      .references(() => mailThread.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.userId] })],
);

// ── Team messages (docs/adr/0035) ───────────────────────────────────────────

/**
 * A conversation between members of one agency. Never a `mail_thread`: an
 * internal message must not be able to reach the buyer portal or the contact
 * inbox, so it does not share their tables.
 */
export const teamThread = pgTable(
  'team_thread',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index('team_thread_agency_idx').on(t.agencyId, desc(t.lastMessageAt))],
);

/** Who is on a team conversation — the only people who may read it — and when each last opened it. */
export const teamThreadMember = pgTable(
  'team_thread_member',
  {
    threadId: uuid('thread_id')
      .notNull()
      .references(() => teamThread.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.userId] }), index('team_thread_member_user_idx').on(t.userId)],
);

/** One message on a team conversation. Plain text, written in the console or answered from a mail client. */
export const teamMessage = pgTable(
  'team_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => teamThread.id, { onDelete: 'cascade' }),
    /** Denormalised, like mail_message, so tenancy is readable without a join. */
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id').references(() => user.id, { onDelete: 'set null' }),
    /** `console`, or `email` when answered from a mail client. */
    channel: varchar('channel', { length: 16 }).notNull().default('console'),
    text: text('text').notNull(),
    /** A received email's id: a webhook delivered twice stores once. */
    providerId: text('provider_id').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('team_message_thread_idx').on(t.threadId, t.createdAt)],
);

// ── Contacts (docs/adr/0018) ────────────────────────────────────────────────

/** How the agency first met this person. */
export const contactSourceEnum = pgEnum('contact_source', [
  'enquiry',
  'offer',
  'email',
  'manual',
  'import',
]);

/** What a person is to the agency. A tag, not a separate table of people. */
export const contactRoleKindEnum = pgEnum('contact_role_kind', [
  'seller',
  'buyer',
  'landlord',
  'tenant',
  'investor',
]);

/** Whether somebody chose a tag, or it was read off what the person did. */
export const contactTagSourceEnum = pgEnum('contact_tag_source', ['manual', 'inferred']);

/** What a person is to an address. "Enquired about" is NOT here — that is `lead`. */
export const contactPropertyRelationEnum = pgEnum('contact_property_relation', [
  'owner',
  'vendor',
  'landlord',
  'tenant',
  'interested',
  'other',
]);

/** Who did a thing on a contact's timeline. */
export const activityActorTypeEnum = pgEnum('activity_actor_type', ['user', 'system', 'skill', 'ai']);

/**
 * One person the agency deals with, whatever they are to it (ADR 0018).
 *
 * Per agency, deliberately: the same buyer approaching two agencies is two
 * contacts, because each agency's notes, assignments and consent are its own.
 *
 * Made automatically by `public.contact_upsert`, which the `lead` and
 * `mail_thread` insert triggers call — so an enquiry, an offer and an email to
 * the agency address all land on the same person, matched on email. A phone
 * match with a different email is never merged; it is shown as a possible
 * duplicate (`phone_key`) for an admin to decide.
 *
 * A merge never deletes: the losing row keeps its id with `merged_into_id` set,
 * so every old link still resolves.
 */
export const contact = pgTable(
  'contact',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Lower-cased and trimmed on every write, so a match is an equality. */
    email: text('email'),
    /** As typed. */
    phone: text('phone'),
    /**
     * Digits only, Australian numbers in international form — `0412 345 678`
     * and `+61 412 345 678` are both `61412345678`. Postgres computes it from
     * `phone` (`public.au_phone_key`); nothing writes it. For duplicate
     * suggestions only, never for an automatic merge.
     */
    phoneKey: text('phone_key').generatedAlwaysAs(sql`public.au_phone_key(phone)`),
    /** The agent whose contact this is. They may edit it in full. */
    assignedTo: uuid('assigned_to').references(() => user.id, { onDelete: 'set null' }),
    /** Flagged by an offboarding (ADR 0030 §5): its person left and it waits in the "Needs an owner" queue. */
    needsOwnerAt: timestamp('needs_owner_at', { withTimezone: true }),
    /** Their website account, when an offer told us (offers need a sign-in). */
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    source: contactSourceEnum('source').notNull().default('manual'),
    /** What should happen next with this person, in the agent's words. */
    nextAction: text('next_action'),
    nextActionAt: timestamp('next_action_at', { withTimezone: true }),
    /**
     * When this person agreed to marketing email, and how we know. Null means
     * NO consent: an enquiry is not consent (the user's decision, 2026-10-05).
     * A dated, attributed fact, because the Spam Act asks who consented and when.
     */
    marketingConsentAt: timestamp('marketing_consent_at', { withTimezone: true }),
    marketingConsentNote: text('marketing_consent_note'),
    marketingConsentBy: uuid('marketing_consent_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    /** When they asked to receive no more marketing. Wins over consent. */
    emailOptOutAt: timestamp('email_opt_out_at', { withTimezone: true }),
    /**
     * Put away by a person — spam, a duplicate nobody wants to merge, somebody
     * gone. Hidden from the directory's default view; nothing else changes and
     * nothing is deleted. A new enquiry from them still lands on this row.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: uuid('archived_by').references(() => user.id, { onDelete: 'set null' }),
    /** Set on the losing side of a merge. Such a row is never listed. */
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => contact.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    /**
     * One live contact per address per agency — what makes the trigger's
     * upsert an upsert. Partial: a merged row keeps its old email without
     * blocking the survivor, and a contact may have no email at all.
     */
    uniqueIndex('contact_agency_email_idx')
      .on(t.agencyId, t.email)
      .where(sql`email is not null and merged_into_id is null`),
    index('contact_agency_phone_key_idx').on(t.agencyId, t.phoneKey),
    index('contact_agency_assigned_idx').on(t.agencyId, t.assignedTo),
    index('contact_agency_created_idx').on(t.agencyId, desc(t.createdAt)),
  ],
);

export const contactRole = pgTable(
  'contact_role',
  {
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    role: contactRoleKindEnum('role').notNull(),
    source: contactTagSourceEnum('source').notNull().default('manual'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.role] }),
    /** "Every seller" is a filter on the directory. */
    index('contact_role_role_idx').on(t.role, t.contactId),
  ],
);

/**
 * A person's tie to an address that is not an enquiry: they own it, are
 * selling it, rent it. Enquiries are read from `lead.property_id`, never
 * copied here — a second record of one fact.
 */
export const contactProperty = pgTable(
  'contact_property',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    /** `restrict`: a property outlives every person and ad tied to it (#1). */
    propertyId: uuid('property_id')
      .notNull()
      .references(() => property.id, { onDelete: 'restrict' }),
    relation: contactPropertyRelationEnum('relation').notNull(),
    note: text('note'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('contact_property_unique_idx').on(t.contactId, t.propertyId, t.relation),
    index('contact_property_property_idx').on(t.propertyId),
  ],
);

/** Something an agent wrote down about a contact. */
export const note = pgTable(
  'note',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => user.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    /**
     * Private: only the agency's admins and the note's author see it — for
     * what should not reach every agent who meets this person through a lead
     * (money, a dispute). `note:read_private` in permissions.ts.
     */
    isPrivate: boolean('is_private').notNull().default(false),
    /**
     * Deleted by its author or an admin. Kept, never shown: a note somebody
     * relied on should not vanish without trace, and nothing here deletes rows.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => user.id, { onDelete: 'set null' }),
    /** Full-text of the note (ADR 0031). Generated; never written. */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(sql`to_tsvector('english', coalesce(body, ''))`),
    ...timestamps,
  },
  (t) => [index('note_contact_idx').on(t.contactId, desc(t.createdAt)), index('note_search_idx').using('gin', t.searchTsv)],
);

/**
 * Timeline entries that have no other home (ADR 0018).
 *
 * A contact's timeline is read as one UNION over `lead`, `mail_message`,
 * `note` and this table. Leads, emails and notes are NOT copied in here — they
 * already have rows. This holds what does not: a contact created or merged, a
 * role added, an assignment, a property linked; later appointments and skill
 * actions. Not the old `event` table: that has no agency, no contact and no
 * foreign key, so tenancy would be a convention and every read a scan.
 *
 * `kind` is text checked by zod (`activityKindSchema` in core), not an enum, so
 * a new kind is a code change rather than a migration.
 */
export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 64 }).notNull(),
    actorType: activityActorTypeEnum('actor_type').notNull().default('user'),
    actorId: uuid('actor_id').references(() => user.id, { onDelete: 'set null' }),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index('activity_contact_idx').on(t.contactId, desc(t.occurredAt))],
);

// ── Appointments (docs/adr/0019) ────────────────────────────────────────────

/**
 * `client`: with a contact (ADR 0019). `team`: an internal meeting between
 * members, with no contact (ADR 0038). A CHECK in 0044 ties the two together:
 * a client appointment has a contact, a team meeting never does.
 */
export const appointmentKindEnum = pgEnum('appointment_kind', ['client', 'team']);

export const appointmentTypeEnum = pgEnum('appointment_type', [
  'appraisal',
  'phone_call',
  'zoom',
  'inspection',
  'meeting',
]);

/**
 * `rescheduled` is still on: it is a scheduled appointment whose time was
 * moved, kept distinct so the list can say so. `completed` and `cancelled`
 * are finished, and carry the outcome note.
 */
export const appointmentStatusEnum = pgEnum('appointment_status', [
  'scheduled',
  'completed',
  'cancelled',
  'rescheduled',
]);

/** One extra person at an appointment besides the contact and the agent. */
export type AppointmentAttendee = { name: string; email: string | null };

/**
 * A booked time with a contact (ADR 0019): an appraisal, a call, an
 * inspection. The platform's own record — Google Calendar and Zoom, when they
 * are connected (Phase 3b), mirror it through the `external_*` and
 * `zoom_meeting_id` columns, which stay empty until then.
 *
 * Times are instants (UTC). `timezone` is the IANA zone the appointment was
 * booked in — what an invitation email prints the time in. The console always
 * shows each viewer their own browser's time.
 */
export const appointment = pgTable(
  'appointment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    kind: appointmentKindEnum('kind').notNull().default('client'),
    /** The contact it is with. Null for a team meeting, and only then (CHECK in 0044). */
    contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'cascade' }),
    /** The address it is about, if any. `restrict`: a property outlives everything (#1). */
    propertyId: uuid('property_id').references(() => property.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    /** Whose appointment it is. They — and admins — may change it. */
    assignedAgentId: uuid('assigned_agent_id').references(() => user.id, { onDelete: 'set null' }),
    /** Flagged by an offboarding (ADR 0030 §5): its person left and it waits in the "Needs an owner" queue. */
    needsOwnerAt: timestamp('needs_owner_at', { withTimezone: true }),
    title: text('title').notNull(),
    type: appointmentTypeEnum('type').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull(),
    status: appointmentStatusEnum('status').notNull().default('scheduled'),
    location: text('location'),
    meetingUrl: text('meeting_url'),
    /** Internal. Never put in an email to the contact. */
    notes: text('notes'),
    /** What happened — written when it is completed, cancelled or moved. */
    outcome: text('outcome'),
    attendees: jsonb('attendees').$type<AppointmentAttendee[]>().notNull().default(sql`'[]'::jsonb`),
    /** Minutes before the start to remind the agent. Stored now; sent by a later phase. */
    reminderMinutes: integer('reminder_minutes'),
    /** When an invitation email was sent to the contact, if one was. */
    invitationSentAt: timestamp('invitation_sent_at', { withTimezone: true }),
    /**
     * Google Calendar mirror (Phase 3b, migration 0027). Our row is the source
     * of truth; the event is a copy in the assigned agent's own calendar.
     */
    externalCalendarId: text('external_calendar_id'),
    externalCalendarProvider: varchar('external_calendar_provider', { length: 32 }),
    /** The connection the event was written with — set null if it is disconnected. */
    externalCalendarAccountId: uuid('external_calendar_account_id').references(() => integrationAccount.id, { onDelete: 'set null' }),
    /** The event's ETag after OUR last write or check — a different one means it was changed in Google. */
    externalCalendarEtag: text('external_calendar_etag'),
    /** pending | synced | failed | conflict | removed; null = not mirrored (no calendar connected). */
    calendarSyncState: varchar('calendar_sync_state', { length: 16 }),
    calendarSyncedAt: timestamp('calendar_synced_at', { withTimezone: true }),
    /** A sentence for the agent. Never a token or a provider body. */
    calendarSyncError: text('calendar_sync_error'),
    /** What Google shows when it differs from ours: { startsAt, endsAt, deleted, seenAt }. Flagged, never applied. */
    calendarConflict: jsonb('calendar_conflict').$type<CalendarConflict>(),
    /** When the read-back last looked at the event. */
    calendarCheckedAt: timestamp('calendar_checked_at', { withTimezone: true }),
    zoomMeetingId: text('zoom_meeting_id'),
    /** The host's connection (the agent's own Zoom, else the agency's) — needed to move or delete it. */
    zoomAccountId: uuid('zoom_account_id').references(() => integrationAccount.id, { onDelete: 'set null' }),
    /** pending | synced | failed | removed; null = not a Zoom meeting we created. */
    zoomSyncState: varchar('zoom_sync_state', { length: 16 }),
    zoomSyncedAt: timestamp('zoom_synced_at', { withTimezone: true }),
    zoomSyncError: text('zoom_sync_error'),
    /** A sync run holds this while it talks to Google / Zoom, so a double submit does not create twice. */
    syncClaimedAt: timestamp('sync_claimed_at', { withTimezone: true }),
    /**
     * The reminder tick claimed this appointment's reminder (ADR 0032 §4) —
     * set once, cleared by a reschedule so the new time is reminded too.
     */
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // One agent is never booked twice at once (ADR 0032 §3): an EXCLUDE
    // constraint on (assigned_agent_id, tstzrange(starts_at, ends_at)) for
    // active rows — hand-written in 0039, not expressible here.
    index('appointment_agency_starts_idx').on(t.agencyId, t.startsAt),
    index('appointment_contact_starts_idx').on(t.contactId, t.startsAt),
    index('appointment_agent_starts_idx').on(t.assignedAgentId, t.startsAt),
    // The cron's read-back and retry sweep: only mirrored rows.
    index('appointment_calendar_sync_idx')
      .on(t.calendarSyncState, t.startsAt)
      .where(sql`calendar_sync_state is not null`),
  ],
);

/**
 * The colleagues on a team meeting (ADR 0038), besides its host
 * (`appointment.assigned_agent_id`). They see it, are told about it and are
 * reminded of it; they may decline, nothing else. Server-only like every
 * table here (RLS on, no browser grants — ADR 0017).
 */
export const appointmentParticipant = pgTable(
  'appointment_participant',
  {
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointment.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    /** "I can't make it." Still on the list, so the host sees who declined; no reminders after it. */
    declinedAt: timestamp('declined_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.appointmentId, t.userId] }),
    index('appointment_participant_user_idx').on(t.userId, t.appointmentId),
  ],
);

export type CalendarConflict = { startsAt: string | null; endsAt: string | null; deleted: boolean; seenAt: string };

/**
 * Something a member should see in the console bell (ADR 0032 §4) — today only
 * "your meeting starts soon". Server-only (RLS on, no grants, ADR 0017); a
 * member reads only their own rows. `dedupeKey` makes the tick idempotent: the
 * same reminder for the same start time is written once, however many ticks
 * see it.
 */
export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    appointmentId: uuid('appointment_id').references(() => appointment.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body'),
    /** A console path (no host) — the surface decides the host. */
    href: text('href'),
    /** A link that opens outside the console, e.g. the Zoom join link. */
    joinUrl: text('join_url'),
    dedupeKey: text('dedupe_key').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_user_dedupe_key').on(t.userId, t.dedupeKey),
    index('notification_user_created_idx').on(t.userId, t.createdAt),
  ],
);

// ── Integrations (docs/adr/0020) ────────────────────────────────────────────

export const integrationProviderEnum = pgEnum('integration_provider', [
  'google_calendar',
  'zoom',
  'google_sheets',
  'google_reviews',
  'gmail',
]);
export const integrationOwnerTypeEnum = pgEnum('integration_owner_type', ['user', 'agency']);
/** No row means "not connected". */
export const integrationStatusEnum = pgEnum('integration_status', [
  'connected',
  'expired',
  'error',
  'permission_missing',
]);

/**
 * One connected account (ADR 0020): a person's Google Calendar, the agency's
 * Zoom. Server-only — RLS on, no grants (ADR 0017) — and the token columns are
 * ciphertext (`integrations/crypto.ts`, AES-256-GCM, key from the environment,
 * bound to this row and column). Nothing that feeds a screen selects them.
 */
export const integrationAccount = pgTable(
  'integration_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    provider: integrationProviderEnum('provider').notNull(),
    ownerType: integrationOwnerTypeEnum('owner_type').notNull(),
    /** The user's id for `user`, the agency's id for `agency`. */
    ownerId: uuid('owner_id').notNull(),
    /** What the provider says the account is — usually its email. */
    externalAccountLabel: text('external_account_label'),
    /**
     * The provider's own id for the account (Zoom: the user id). Zoom's
     * deauthorization notice names only this, so it is how that notice finds
     * the rows to delete (ADR 0037). Null for rows connected before it existed.
     */
    externalAccountId: text('external_account_id'),
    grantedScopes: text('granted_scopes').array().notNull().default(sql`'{}'::text[]`),
    status: integrationStatusEnum('status').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /** Why it is in `error`. Never contains a token. */
    lastError: text('last_error'),
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    connectedBy: uuid('connected_by').references(() => user.id, { onDelete: 'set null' }),
    /**
     * An agency-level account whose connecting person has left (ADR 0030 §5.4,
     * decided Q8): it keeps working, flagged for an admin to reconnect with an
     * account the agency controls. Cleared by reconnecting.
     */
    connectorLeftAt: timestamp('connector_left_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('integration_account_owner_idx').on(t.provider, t.ownerType, t.ownerId),
    index('integration_account_agency_idx').on(t.agencyId),
    index('integration_account_external_idx').on(t.provider, t.externalAccountId),
  ],
);

/**
 * `interval` is a different kind of thing from the other two, and the
 * difference is daylight saving.
 *
 * "Every day at 8 PM" is a statement about a wall clock: it must stay at
 * 8 PM when the clock moves, so it is resolved against a timezone. "Every
 * two hours" is a statement about elapsed time and has no opinion about
 * what the clock reads — on the morning the clock goes forward, there is
 * simply one fewer gap. Trying to express one as the other is how a
 * scheduler ends up firing twice at 2 AM once a year.
 */
export const scheduleCadenceEnum = pgEnum('schedule_cadence', ['daily', 'weekly', 'interval']);

/**
 * `failing` is not a kind of `paused`.
 *
 * Paused is a decision somebody made — they unsubscribed, or switched it off.
 * Failing is the system giving up after three consecutive errors. They look
 * the same on a list and they mean opposite things: one needs nothing, the
 * other needs someone to look. Folding them together is how a broken alert
 * becomes a silent one.
 */
export const scheduleStatusEnum = pgEnum('schedule_status', ['active', 'paused', 'failing']);

/**
 * IANA zone names, never a UTC offset.
 *
 * "8 PM in Melbourne" is +11 for part of the year and +10 for the rest, so a
 * stored offset is wrong for about five months a year. An enum rather than
 * text because a typo here does not produce a bad filter — it produces an
 * alert that never fires and never says why.
 */
export const auTimezoneEnum = pgEnum('au_timezone', [
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Brisbane',
  'Australia/Adelaide',
  'Australia/Perth',
  'Australia/Hobart',
  'Australia/Darwin',
  'Australia/Broken_Hill',
  'Australia/Lord_Howe',
  'Australia/Eucla',
]);

export const scheduleRunStatusEnum = pgEnum('schedule_run_status', [
  'running',
  'delivered',
  'empty',
  'failed',
]);

/** Per-channel delivery outcome. `skipped` is a budget or configuration refusal. */
export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'sent',
  'failed',
  'skipped',
]);

/** Who wrote the summary. `template` means the model was refused or rejected. */
export const summarySourceEnum = pgEnum('summary_source', ['model', 'template', 'none']);

/**
 * A saved search that runs on a clock.
 *
 * Replaces `saved_search`, which was written in migration 0000 and never read
 * or written by anything. It had no prompt column, no cursor, no timezone, and
 * a free-text `frequency` — a shape guessed before the feature existed.
 *
 * `query` is frozen when the schedule is saved and `prompt` is kept beside it:
 * see docs/adr/0010. The prompt is for showing back and for a
 * re-interpretation the person explicitly asks for. Nothing in the run path
 * reads it.
 */
export const searchSchedule = pgTable(
  'search_schedule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The sentence, verbatim. Never re-interpreted without being asked. */
    prompt: text('prompt').notNull(),
    /** A PublicSearchQuery. Parsed with publicSearchQuerySchema on every read. */
    query: jsonb('query').notNull(),
    /**
     * Which prompt version resolved it, for the same reason `ai_run` records
     * the model id it sent: "why does this search look like that" has to stay
     * answerable after the prompt has moved on.
     */
    promptVersion: varchar('prompt_version', { length: 64 }).notNull(),
    cadence: scheduleCadenceEnum('cadence').notNull().default('daily'),
    /** Local wall-clock minutes past midnight. 1200 is 8 PM, and stays 8 PM. */
    sendAtMinute: integer('send_at_minute').notNull(),
    /** 0 = Sunday. Null unless cadence is weekly. */
    sendOnWeekday: integer('send_on_weekday'),
    /**
     * Elapsed minutes between runs. Null unless cadence is `interval`.
     *
     * Floored at 60 in the contract: the tick runs every 15 minutes, so
     * anything finer is a promise the scheduler cannot keep, and a person
     * who asks for "every five minutes" wants a notification product rather
     * than a digest.
     */
    intervalMinutes: integer('interval_minutes'),
    timezone: auTimezoneEnum('timezone').notNull(),
    /**
     * The absolute instant, derived from the four columns above by
     * `nextRunFor`. Stored so the due scan is an index range rather than ten
     * timezone conversions per row, and recomputed on every claim so a tzdata
     * update heals itself on the next tick instead of needing a backfill.
     */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    status: scheduleStatusEnum('status').notNull().default('active'),
    /** Reset to 0 by any successful run. Three in a row moves status to failing. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /**
     * When the person unsubscribed, and null otherwise.
     *
     * Deliberately separate from `status = 'paused'`. The Spam Act wants an
     * unsubscribe to be a recorded, dated fact, and "they paused it" is not
     * the same defence as "they asked us to stop, at this time".
     */
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    /**
     * Partial, on purpose. The due scan only ever wants active rows, and a
     * paused schedule frozen at a next_run_at in the past would otherwise sit
     * at the front of every index scan forever. The predicate is written by
     * hand in the migration — see the note there.
     */
    index('search_schedule_due_idx').on(t.nextRunAt),
    index('search_schedule_user_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * One execution of one schedule, and the record of what was sent.
 *
 * The listings are SNAPSHOTTED rather than re-read. A run is the record of
 * what was true at 8 PM; opening /alerts three days later and seeing a
 * different set — or watching a withdrawn listing vanish out of it — would
 * leave no way to answer "why was I emailed this". Same reasoning as storing
 * `price_display` beside the numeric columns.
 *
 * This table IS the in-app delivery. /alerts and the chat card read it
 * directly, which is why there is no in-app delivery status beside
 * `email_status`: a column saying 'sent' next to a row that exists would be a
 * second copy of one fact. `seen_at` is the only thing the in-app channel can
 * report that the row's existence does not already say.
 */
export const scheduleRun = pgTable(
  'schedule_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => searchSchedule.id, { onDelete: 'cascade' }),
    /**
     * Denormalised from the schedule, deliberately.
     *
     * /alerts, the chat card and the RLS policy all ask "is this mine", and a
     * policy that has to join to answer is a policy nobody can read. Set once,
     * from the schedule row, inside the claim.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /**
     * The slot this run belongs to — the `next_run_at` that was claimed.
     *
     * With the unique index below this is the real idempotency key, and it is
     * the one that holds where a row lock cannot: two overlapping ticks, a
     * manual re-run, a cron platform that fires twice, and a retry after a
     * deploy all collide here rather than sending two emails.
     */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    status: scheduleRunStatusEnum('status').notNull().default('running'),
    /** The query AS RUN. The schedule's may be re-frozen later; this may not. */
    query: jsonb('query').notNull(),
    matched: integer('matched'),
    /** New since the previous run, by set difference on listing id. From SQL. */
    newCount: integer('new_count'),
    /** PublicListingSummary[], capped. Dates revive at the read boundary. */
    listings: jsonb('listings').notNull().default(sql`'[]'::jsonb`),
    listingIds: uuid('listing_ids').array(),
    summary: text('summary'),
    summarySource: summarySourceEnum('summary_source').notNull().default('none'),
    emailStatus: deliveryStatusEnum('email_status').notNull().default('pending'),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    emailError: text('email_error'),
    /** When the person opened it in the app. Null until they do. */
    seenAt: timestamp('seen_at', { withTimezone: true }),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('schedule_run_slot_idx').on(t.scheduleId, t.scheduledFor),
    index('schedule_run_user_idx').on(t.userId, t.createdAt),
  ],
);

export const chatRoleEnum = pgEnum('chat_role', ['user', 'assistant']);

/**
 * One saved conversation with the property guide.
 *
 * Only ever written for a signed-in visitor. `/chat` is public and stays
 * public: an anonymous conversation is not stored at all, which is both the
 * smaller privacy surface and the honest behaviour for somebody who has not
 * told us who they are.
 */
export const chatThread = pgTable(
  'chat_thread',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Derived from the first message. A person renames it by never seeing it. */
    title: text('title').notNull(),
    /**
     * Sorted on, so it is stored rather than derived from a join to the last
     * message — a thread list is one statement, not one per row.
     */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index('chat_thread_user_idx').on(t.userId, t.lastMessageAt)],
);

/**
 * One turn, stored in exactly the shape the client is already allowed to send.
 *
 * This is the load-bearing constraint and the reason storing a transcript is
 * safe at all. `chatRequestSchema` deliberately gives a client no way to
 * send a tool result, because a tool result is the only source of a price
 * (#4) — so a stored assistant turn holds `text` and `searches` citations
 * and NOTHING ELSE that goes back to the model. Replaying one is byte-for-
 * byte what the browser already posts today, so persistence opens no new
 * trust surface.
 *
 * `resultsFrame` is the exception and it is display-only: it redraws the
 * listing chips under an answer when a thread is reopened. It is never put
 * in a request, and `loadThreadForModel` in packages/core does not read it.
 */
export const chatMessage = pgTable(
  'chat_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => chatThread.id, { onDelete: 'cascade' }),
    /** Denormalised so the RLS policy is readable without a join. */
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: chatRoleEnum('role').notNull(),
    text: text('text').notNull(),
    /** The citation shape chatRequestSchema accepts: query, matched, shown. */
    searches: jsonb('searches'),
    /** DISPLAY ONLY. Never sent to the model. See the note above. */
    resultsFrame: jsonb('results_frame'),
    /**
     * DISPLAY ONLY, like `resultsFrame`: the `recent_sales` frame, so a
     * reopened thread redraws its sold cards, map and "View all sold" link
     * instead of an empty panel under an answer that points at it.
     */
    salesFrame: jsonb('sales_frame'),
    /** The `/search?…` this turn produced, if any. */
    deepLink: text('deep_link'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_message_thread_idx').on(t.threadId, t.createdAt)],
);

export const shortlist = pgTable(
  'shortlist',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listing.id, { onDelete: 'cascade' }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.listingId] })],
);

export const event = pgTable('event', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: varchar('type', { length: 128 }).notNull(),
  entityType: varchar('entity_type', { length: 64 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  actorId: uuid('actor_id').references(() => user.id, { onDelete: 'set null' }),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiRun = pgTable('ai_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  feature: varchar('feature', { length: 128 }).notNull(),
  model: varchar('model', { length: 128 }).notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
  latencyMs: integer('latency_ms'),
  entityId: uuid('entity_id'),
  /**
   * Whose call this was, when there is a whose.
   *
   * Nullable, because the consumer chat is anonymous and always will be —
   * this is null for every `/chat` turn. It exists for the scheduler's spend
   * budget, which has to answer "how much has this account cost today" and
   * had no way to: `entity_id` correlates the several API requests that make
   * up one turn, which is a different question.
   *
   * `set null` on delete rather than cascade: the cost history of a closed
   * account is still the platform's own accounting, and keeping it without
   * the id keeps the total right without identifying anybody (APP 11).
   */
  userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
  /**
   * The agency the call was made for, when there is one (ADR 0025): the
   * assistant's per-agency daily cap sums on it. Null for the anonymous chat
   * and for every row written before migration 0028. `set null` for the same
   * reason as `user_id`.
   */
  agencyId: uuid('agency_id').references(() => agency.id, { onDelete: 'set null' }),
  promptVersion: varchar('prompt_version', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});


// ── Skills (docs/adr/0021) ──────────────────────────────────────────────────

/** The code a skill runs. Editing a skill's Markdown never changes this. */
export const skillHandlerEnum = pgEnum('skill_handler', ['morning_brief', 'important_emails', 'template_email']);
/** Which model tier a skill asks for — mapped to a model id in packages/ai. */
export const skillModelTierEnum = pgEnum('skill_model_tier', ['summary', 'agent', 'hard']);
export const skillRunStatusEnum = pgEnum('skill_run_status', ['running', 'succeeded', 'failed', 'skipped']);
export const skillRunTriggerEnum = pgEnum('skill_run_trigger', ['schedule', 'manual']);

/**
 * A library skill: a prompt (Markdown with front-matter) over a fixed handler.
 * `agency_id` null = the platform's own library; set = that agency's, curated
 * by its admins. `requires` is parsed from the front-matter on save.
 */
export const skill = pgTable(
  'skill',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id').references(() => agency.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 80 }).notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    handler: skillHandlerEnum('handler').notNull(),
    bodyMd: text('body_md').notNull(),
    requires: text('requires').array().notNull().default(sql`'{}'::text[]`),
    modelTier: skillModelTierEnum('model_tier').notNull().default('summary'),
    defaultCadence: scheduleCadenceEnum('default_cadence').notNull().default('daily'),
    defaultSendAtMinute: integer('default_send_at_minute').notNull().default(420),
    defaultSendOnWeekday: integer('default_send_on_weekday'),
    defaultIntervalMinutes: integer('default_interval_minutes'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('skill_scope_slug_idx').on(sql`coalesce(${t.agencyId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.slug),
  ],
);

/**
 * One agent's copy of a skill: their own words, their own schedule. Only they
 * manage it (`agent_skill:manage`). Off until they switch it on; a skill whose
 * `requires` are not connected cannot be switched on.
 */
export const agentSkill = pgTable(
  'agent_skill',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skill.id, { onDelete: 'restrict' }),
    bodyMd: text('body_md').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /** Also email the result to the agent themselves. */
    emailMe: boolean('email_me').notNull().default(false),
    cadence: scheduleCadenceEnum('cadence').notNull().default('daily'),
    sendAtMinute: integer('send_at_minute').notNull().default(420),
    sendOnWeekday: integer('send_on_weekday'),
    intervalMinutes: integer('interval_minutes'),
    /** IANA zone, validated in core. Where "7 AM" is. */
    timezone: text('timezone').notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    /** Three in a row and the scheduler stops claiming it; a good run resets it. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Removed from the agent's list. Runs are kept. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('agent_skill_user_skill_idx').on(t.userId, t.skillId).where(sql`archived_at is null`),
    index('agent_skill_due_idx').on(t.nextRunAt).where(sql`enabled and archived_at is null`),
  ],
);

/** One execution of an agent's skill. Cost: `ai_run` rows whose entity_id is this id. */
export const skillRun = pgTable(
  'skill_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentSkillId: uuid('agent_skill_id')
      .notNull()
      .references(() => agentSkill.id, { onDelete: 'cascade' }),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    trigger: skillRunTriggerEnum('trigger').notNull(),
    /** The slot. With the unique index, what makes a double-fired tick harmless. */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    status: skillRunStatusEnum('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** The assistant's text, already checked (citations, no invented numbers). */
    summary: text('summary'),
    summarySource: summarySourceEnum('summary_source').notNull().default('none'),
    /** What the handler read, as SQL rendered it — lists, times, record ids. */
    result: jsonb('result'),
    error: text('error'),
    itemsProcessed: integer('items_processed').notNull().default(0),
    model: text('model'),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('skill_run_slot_idx').on(t.agentSkillId, t.scheduledFor),
    index('skill_run_user_idx').on(t.userId, desc(t.createdAt)),
  ],
);


// ── Template email (docs/adr/0022) ──────────────────────────────────────────

/** A directory filter an agent saved, to choose recipients from. */
export const contactFilter = pgTable(
  'contact_filter',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** A ContactListQuery (q, role, source, assigned, archived), parsed on every read. */
    query: jsonb('query').notNull(),
    ...timestamps,
  },
  (t) => [index('contact_filter_user_idx').on(t.userId, desc(t.createdAt))],
);

export const emailTemplateStatusEnum = pgEnum('email_template_status', [
  'draft',
  'pending_approval',
  'approved',
  'retired',
]);

/**
 * A marketing email the agency may send in bulk. Anyone may draft one; only
 * an owner/admin approves it, and only an approved one can be used. Approved
 * templates are not edited — retire and write a new one, so a sent email can
 * always be traced to the exact text approved.
 */
export const emailTemplate = pgTable(
  'email_template',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    /** Plain text with merge fields like {{first_name}}. */
    body: text('body').notNull(),
    status: emailTemplateStatusEnum('status').notNull().default('draft'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references(() => user.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    /**
     * ADR 0043: usable by everyone in the agency (made by an owner/admin), or only by its
     * author (made by an agent). A template is ready when saved — there is no approval step.
     */
    agencyWide: boolean('agency_wide').notNull().default(false),
    ...timestamps,
  },
  (t) => [index('email_template_agency_idx').on(t.agencyId, t.status)],
);

export const emailBatchStatusEnum = pgEnum('email_batch_status', [
  'prepared',
  'approved_sending',
  'sent',
  'expired',
  'cancelled',
]);

/**
 * One Prepare → Approve & Send. The recipients, the template text and the
 * filter are FROZEN when it is prepared; nothing that changes afterwards
 * (except a contact opting out, re-checked at send) alters what was shown.
 */
export const emailBatch = pgTable(
  'email_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => emailTemplate.id, { onDelete: 'restrict' }),
    filterId: uuid('filter_id').references(() => contactFilter.id, { onDelete: 'set null' }),
    /** The template's name, subject and body as approved, at Prepare. */
    templateSnapshot: jsonb('template_snapshot').notNull(),
    /** The filter's name and query, at Prepare. */
    filterSnapshot: jsonb('filter_snapshot').notNull(),
    status: emailBatchStatusEnum('status').notNull().default('prepared'),
    preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull().defaultNow(),
    /** prepared_at + 48 h. Past it, the batch cannot be approved. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('email_batch_agency_idx').on(t.agencyId, desc(t.preparedAt)),
    index('email_batch_user_idx').on(t.userId, desc(t.preparedAt)),
  ],
);

export const emailRecipientStatusEnum = pgEnum('email_recipient_status', [
  'queued',
  'sending',
  'sent',
  'failed',
  'skipped',
]);

/** One person in a batch, frozen at Prepare: who, which address, and why skipped if skipped. */
export const emailBatchRecipient = pgTable(
  'email_batch_recipient',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => emailBatch.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    status: emailRecipientStatusEnum('status').notNull(),
    /** Why skipped: opted_out, archived, no_consent, no_email, batch_limit, dev_allowlist (recently_emailed: old batches only, ADR 0043). */
    skipReason: varchar('skip_reason', { length: 32 }),
    /** Skipped at Prepare, or only at the moment of sending. */
    skippedAtSend: boolean('skipped_at_send').notNull().default(false),
    threadId: uuid('thread_id').references(() => mailThread.id, { onDelete: 'set null' }),
    mailMessageId: uuid('mail_message_id').references(() => mailMessage.id, { onDelete: 'set null' }),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('email_batch_recipient_unique_idx').on(t.batchId, t.contactId),
    index('email_batch_recipient_status_idx').on(t.batchId, t.status),
  ],
);

// ── Console assistant (docs/adr/0025) ───────────────────────────────────────

/**
 * One person's conversation with the console assistant. Seen and continued
 * by its author only — not even an admin (ADR 0025 Q5). Deleted 30 days after
 * its last turn by the cron tick.
 *
 * `handles` is the server's map from the short names the model was shown
 * (`C1`, `L3`, `S1`…) to row ids — `{ "C1": { "k": "contact", "id": "…" } }`.
 * The model never sees an id; anything it refers to is looked up here and
 * then checked again, as this person, by the scoped query that uses it.
 */
export const assistantConversation = pgTable(
  'assistant_conversation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Which console it was started in: `agent` or `agency`. */
    surface: varchar('surface', { length: 16 }).notNull(),
    /** The first question, cut short — the list's label. */
    title: text('title').notNull(),
    handles: jsonb('handles').notNull().default({}),
    turnCount: integer('turn_count').notNull().default(0),
    /** Set while a turn runs: one turn at a time per conversation (two tabs, a double send). */
    turnStartedAt: timestamp('turn_started_at', { withTimezone: true }),
    lastTurnAt: timestamp('last_turn_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    index('assistant_conversation_user_idx').on(t.userId, desc(t.lastTurnAt)),
    index('assistant_conversation_last_turn_idx').on(t.lastTurnAt),
  ],
);

/**
 * One question and its answer. `api_messages` is exactly what was sent to and
 * received from the model in this turn — replayed verbatim, append-only, on
 * the next turn (so earlier turns are never edited, which keeps the prompt
 * cache and the model's own reasoning blocks valid). Null on a failed turn,
 * which is shown but never replayed. `frames` are the lists the panel drew,
 * rendered from SQL.
 */
export const assistantTurn = pgTable(
  'assistant_turn',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => assistantConversation.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    /** `done` or `failed`. */
    status: varchar('status', { length: 16 }).notNull(),
    userText: text('user_text').notNull(),
    answer: text('answer').notNull().default(''),
    frames: jsonb('frames').notNull().default([]),
    apiMessages: jsonb('api_messages'),
    error: text('error'),
    model: text('model'),
    toolCalls: integer('tool_calls').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('assistant_turn_seq_idx').on(t.conversationId, t.seq)],
);

/**
 * An assistant task (ADR 0040): a plan of up to 10 steps the person approved
 * once, on one card. Its steps are `proposed_action` rows (`task_id`,
 * `task_seq`) run in order by the minute tick, as the approver as they are
 * then; one that fails stops the task. Lives up to 30 days.
 */
export const assistantTask = pgTable(
  'assistant_task',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => assistantConversation.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** proposed → active → done | failed | cancelled | expired. */
    status: varchar('status', { length: 16 }).notNull().default('proposed'),
    /** The step that stopped it, and why — for the card and the model. */
    error: text('error'),
    /** No step runs after this (30 days from when it was planned). */
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('assistant_task_user_idx').on(t.userId, t.status)],
);

/**
 * A workflow (ADR 0041 Part B): WHEN one trigger, IF its conditions, THEN its actions — a spec from
 * the fixed catalog (packages/core/src/workflows/catalog.ts), never code. It runs as its owner, as
 * they are at run time. `mine`: only the owner's own leads and contacts; `agency`: the whole agency
 * (owners/admins only). "Delete" archives.
 */
export const workflow = pgTable(
  'workflow',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    scope: varchar('scope', { length: 8 }).notNull().default('mine'),
    name: varchar('name', { length: 80 }).notNull(),
    /** The validated spec: { trigger, conditions, actions }, record ids resolved. */
    spec: jsonb('spec').notNull(),
    /** active | paused | archived. */
    status: varchar('status', { length: 12 }).notNull().default('active'),
    /** Why it is paused, when the system paused it (its owner left, a limit). */
    pausedReason: text('paused_reason'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [index('workflow_agency_idx').on(t.agencyId, t.status), index('workflow_owner_idx').on(t.ownerId, t.status)],
);

/**
 * Something that happened, written in the SAME transaction as the change (a transactional outbox,
 * ADR 0041): a rolled-back change emits nothing. Ids only — no text. The minute tick matches each to
 * workflows once. `origin = workflow`: caused by a workflow's own action — never triggers one (v1).
 */
export const workflowEvent = pgTable(
  'workflow_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    leadId: uuid('lead_id'),
    contactId: uuid('contact_id'),
    listingId: uuid('listing_id'),
    appointmentId: uuid('appointment_id'),
    actorId: uuid('actor_id'),
    /** person | website | workflow | system. */
    origin: varchar('origin', { length: 12 }).notNull().default('person'),
    /** The trigger's own facts: `{ to: 'closed' }`, `{ source: 'website' }`, `{ days: 3 }`. Never free text. */
    data: jsonb('data').notNull().default({}),
    /** For events found by a scan (lead.no_reply): one per thing it is about. */
    dedupeKey: text('dedupe_key'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    index('workflow_event_pending_idx').on(t.occurredAt).where(sql`processed_at is null`),
    uniqueIndex('workflow_event_dedupe_idx').on(t.agencyId, t.dedupeKey).where(sql`dedupe_key is not null`),
  ],
);

/** One workflow run for one event — never two (the unique index). Its actions are an ADR 0040 task. */
export const workflowRun = pgTable(
  'workflow_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflow.id, { onDelete: 'cascade' }),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').references(() => workflowEvent.id, { onDelete: 'set null' }),
    /** started | skipped | failed (the run itself; its steps' outcomes are on its task). */
    status: varchar('status', { length: 12 }).notNull().default('started'),
    taskId: uuid('task_id').references(() => assistantTask.id, { onDelete: 'set null' }),
    /** The record it acted on, for the run log: a contact's or lead's id. */
    contactId: uuid('contact_id'),
    leadId: uuid('lead_id'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('workflow_run_once_idx').on(t.workflowId, t.eventId),
    index('workflow_run_recent_idx').on(t.workflowId, desc(t.createdAt)),
  ],
);

/**
 * An action the assistant PROPOSED and only a person may run (ADR 0025 §1, §7).
 *
 * `args` are frozen and RESOLVED — row ids, instants, the exact text — never
 * the model's references. `card` is the snapshot the person saw, built from the
 * database at proposal time, so the audit shows exactly what was approved.
 * Approve claims the row (`proposed` → `running`) in the same transaction that
 * runs it, so a double click runs it once. Kept after its conversation is
 * purged (`set null`): it is the audit.
 */
export const proposedAction = pgTable(
  'proposed_action',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => assistantConversation.id, { onDelete: 'set null' }),
    turnId: uuid('turn_id'),
    /** assistant: a card in a conversation; workflow: a workflow's step or draft (ADR 0041). */
    origin: varchar('origin', { length: 12 }).notNull().default('assistant'),
    /** The contact it is about, for the timeline. */
    contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
    tool: varchar('tool', { length: 48 }).notNull(),
    args: jsonb('args').notNull(),
    card: jsonb('card').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('proposed'),
    /** `conversation:tool_use_id`: a retried model request cannot make a second card. */
    idempotencyKey: text('idempotency_key').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => user.id, { onDelete: 'set null' }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /**
     * When the model was told how this card ended (ADR 0039 Phase 1): set as the
     * outcome goes into a turn's <card_updates>, cleared again if that turn fails
     * (a failed turn is never replayed, so the model would not have seen it).
     */
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    /**
     * A step of an assistant task (ADR 0040): the task it belongs to and its
     * place in it. A step is a card like any other — frozen args, the same
     * execute(), the same re-checks — that waits (`blocked`) until the step
     * before it is done, then runs at its time.
     */
    taskId: uuid('task_id').references((): AnyPgColumn => assistantTask.id, { onDelete: 'cascade' }),
    taskSeq: integer('task_seq'),
    /** Per-step state for multi-step tools, so a resumed run skips what is done. */
    steps: jsonb('steps').notNull().default({}),
    result: jsonb('result'),
    error: text('error'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('proposed_action_idempotency_idx').on(t.idempotencyKey),
    index('proposed_action_user_idx').on(t.userId, desc(t.createdAt)),
  ],
);

/**
 * A saved dashboard (ADR 0027): a list of widgets from the FIXED registry in
 * packages/core/src/widgets — `{ widget, params }`, re-parsed on every read —
 * never code, SQL or numbers. Saved by owners/admins only; opened by signed-in
 * members of the same agency per `audience`; every figure computed AS THE
 * VIEWER. No share link exists.
 */
export const dashboard = pgTable(
  'dashboard',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    widgets: jsonb('widgets').notNull(),
    /** `private` (its creator), `admins` (owners and admins), `agency` (every active member). */
    audience: varchar('audience', { length: 16 }).notNull().default('admins'),
    /** ADR 0047: `{ colors: ['#RRGGBB', …] }` when the person asked for colours; null = the console's palette. */
    theme: jsonb('theme'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('dashboard_agency_idx').on(t.agencyId, desc(t.createdAt))],
);

/**
 * The dashboard gap log (ADR 0036, decided Q2): a figure somebody asked the
 * assistant for that the semantic catalog cannot make — so it becomes a
 * backlog, not an approximation. Read by the platform team, never shown to
 * the model. `request` is the person's own words, trimmed; the nearest
 * dataset / measure are what the model thought was closest, if any.
 */
export const dashboardGapLog = pgTable(
  'dashboard_gap_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    request: text('request').notNull(),
    nearestDataset: varchar('nearest_dataset', { length: 40 }),
    wanted: text('wanted'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dashboard_gap_log_dataset_idx').on(t.nearestDataset, desc(t.createdAt))],
);

// ── Open questions on an agency's data (docs/adr/0042) ─────────────────────

/**
 * The ticket an open query runs under (ADR 0042 L4). Inserted INSIDE the
 * query's own transaction and rolled back with it, so it is never committed
 * and no other session ever sees one. The `ai` schema's views keep only the
 * rows of the agency whose ticket `ai.ticket` names. RLS on, no policy, no
 * grant: `ai_reader` cannot read it — only `ai.ticket_agency()` can.
 */
export const aiQueryTicket = pgTable('ai_query_ticket', {
  id: uuid('id').primaryKey().defaultRandom(),
  agencyId: uuid('agency_id')
    .notNull()
    .references(() => agency.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every open query that ran (ADR 0042): who, what, how long, how it ended.
 * The per-agency hourly cap counts these. `sql` is the model's query as it
 * was run; never shown to anyone but the platform team. Kept 90 days.
 */
export const aiQueryLog = pgTable(
  'ai_query_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    /** `assistant` (run_query in a turn) or `tile` (an open tile on a dashboard). */
    via: varchar('via', { length: 16 }).notNull(),
    sql: text('sql').notNull(),
    /** `ok`, `rejected` (the guard said no), `error` (Postgres said no), `too_slow`, `capped`. */
    outcome: varchar('outcome', { length: 16 }).notNull(),
    detail: text('detail'),
    ms: integer('ms'),
    rows: integer('rows'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_query_log_agency_idx').on(t.agencyId, desc(t.createdAt))],
);

// ── Listing import (docs/adr/0029) ──────────────────────────────────────────

/**
 * One CSV import: uploaded → mapped → validating → validated → importing →
 * done | failed | cancelled. Worked through in chunks of ~100 rows, by the open
 * page and by the cron tick (so a closed tab loses nothing). `file_text` is
 * the uploaded file, kept 30 days after the import finishes, then cleared.
 */
export const listingImport = pgTable(
  'listing_import',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    fileName: text('file_name').notNull(),
    fileHash: varchar('file_hash', { length: 64 }).notNull(),
    fileText: text('file_text'),
    /** What is imported (ADR 0029 amendment): `listings`, or `contacts` — the same job, its own columns and steps. */
    kind: varchar('kind', { length: 16 }).notNull().default('listings'),
    /** Where the rows came from (ADR 0029 amendment): an uploaded `csv` or `xlsx`, or a Google `sheet`. */
    source: varchar('source', { length: 16 }).notNull().default('csv'),
    /** A sheet's `{ spreadsheetId, tab, title }`, so Re-import reads the same file and tab. Null for an upload. */
    sourceRef: jsonb('source_ref'),
    headers: jsonb('headers').notNull().default([]),
    /** Our field → the file's column index (or null). */
    mapping: jsonb('mapping').notNull().default({}),
    status: varchar('status', { length: 16 }).notNull().default('mapped'),
    /** `live` | `draft` (owner/admin) or `pending` (an agent's import, ADR 0014). */
    mode: varchar('mode', { length: 16 }).notNull().default('pending'),
    /** Admin-only "Update from file": rows matching an active listing update it instead of skipping. */
    updateDuplicates: boolean('update_duplicates').notNull().default(false),
    totalRows: integer('total_rows').notNull().default(0),
    /** A short lease on the job, so two workers never run the same chunk. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('listing_import_agency_idx').on(t.agencyId, desc(t.createdAt))],
);

/** One row of an import: the cells, what they became, and what happened. */
export const listingImportRow = pgTable(
  'listing_import_row',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importId: uuid('import_id')
      .notNull()
      .references(() => listingImport.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number').notNull(),
    /** The file's cells; cleared with the file after 30 days. */
    raw: jsonb('raw'),
    /** After mapping, validation and geocoding — what the import writes. */
    normalized: jsonb('normalized'),
    /** pending | valid | error | duplicate | imported | updated | failed | skipped */
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    errors: jsonb('errors').notNull().default([]),
    warnings: jsonb('warnings').notNull().default([]),
    duplicateOfListingId: uuid('duplicate_of_listing_id').references(() => listing.id, { onDelete: 'set null' }),
    listingId: uuid('listing_id').references(() => listing.id, { onDelete: 'set null' }),
    /** A contacts import's row: the contact it made (ADR 0029 amendment). */
    contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
    /** Per photo link: pending | done | failed (with why). */
    photos: jsonb('photos').notNull().default([]),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('listing_import_row_number_idx').on(t.importId, t.rowNumber),
    index('listing_import_row_status_idx').on(t.importId, t.status),
  ],
);

export type User = typeof user.$inferSelect;
export type Agency = typeof agency.$inferSelect;
export type Listing = typeof listing.$inferSelect;
export type Property = typeof property.$inferSelect;
export type Membership = typeof membership.$inferSelect;
// ── Google reviews, step 1 (docs/adr/0028) ──────────────────────────────────

/**
 * The agency's Google listing, picked by search. ONLY the place id is kept:
 * Google's Places terms allow storing a place id indefinitely and nothing
 * else — name, address, rating and reviews are fetched live each time and
 * shown with Google's attribution. Unique per agency for now (one listing
 * per agency, decided Q6); a table so several offices can come later.
 */
export const agencyGooglePlace = pgTable(
  'agency_google_place',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    placeId: text('place_id').notNull(),
    pickedBy: uuid('picked_by').references(() => user.id, { onDelete: 'set null' }),
    pickedAt: timestamp('picked_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex('agency_google_place_agency_idx').on(t.agencyId)],
);

// ── Assistant search (docs/adr/0031) ────────────────────────────────────────

/**
 * Embeddings of note, email and enquiry text for the assistant's search, one
 * row per chunk. Optional (EMBEDDINGS_PROVIDER); full-text works without it.
 * Filled by the cron tick, never on a write path. Rows are pruned as soon as
 * their source stops qualifying (private, deleted, archived or opted-out
 * contact, private offer), and go with their contact (cascade).
 */
export const searchEmbedding = pgTable(
  'search_embedding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agency.id, { onDelete: 'cascade' }),
    /** `note` | `email` | `enquiry` — which table `source_id` points into. */
    sourceKind: varchar('source_kind', { length: 16 }).notNull(),
    sourceId: uuid('source_id').notNull(),
    contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    /** md5 of the whole source text when embedded: unchanged text is never re-embedded. */
    contentHash: text('content_hash').notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('search_embedding_source_idx').on(t.sourceKind, t.sourceId, t.chunkIndex),
    index('search_embedding_agency_idx').on(t.agencyId),
    index('search_embedding_vector_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export type ListingAgent = typeof listingAgent.$inferSelect;
export type AgentProfile = typeof agentProfile.$inferSelect;
export type SearchSchedule = typeof searchSchedule.$inferSelect;
export type ScheduleRun = typeof scheduleRun.$inferSelect;
export type ChatThread = typeof chatThread.$inferSelect;
export type ChatMessage = typeof chatMessage.$inferSelect;
export type AgentInvite = typeof agentInvite.$inferSelect;
export type Lead = typeof lead.$inferSelect;
export type MailThread = typeof mailThread.$inferSelect;
export type MailMessage = typeof mailMessage.$inferSelect;
export type Contact = typeof contact.$inferSelect;
export type ContactRole = typeof contactRole.$inferSelect;
export type ContactProperty = typeof contactProperty.$inferSelect;
export type Note = typeof note.$inferSelect;
export type Activity = typeof activity.$inferSelect;
export type Appointment = typeof appointment.$inferSelect;
export type Notification = typeof notification.$inferSelect;
export type IntegrationAccount = typeof integrationAccount.$inferSelect;
export type Skill = typeof skill.$inferSelect;
export type AgentSkill = typeof agentSkill.$inferSelect;
export type SkillRun = typeof skillRun.$inferSelect;
export type EmailTemplate = typeof emailTemplate.$inferSelect;
export type EmailBatch = typeof emailBatch.$inferSelect;
export type EmailBatchRecipient = typeof emailBatchRecipient.$inferSelect;
export type ContactFilter = typeof contactFilter.$inferSelect;
export type AssistantConversation = typeof assistantConversation.$inferSelect;
export type AssistantTurn = typeof assistantTurn.$inferSelect;
export type ProposedAction = typeof proposedAction.$inferSelect;
export type Dashboard = typeof dashboard.$inferSelect;
export type ListingImport = typeof listingImport.$inferSelect;
export type ListingImportRow = typeof listingImportRow.$inferSelect;
export type AgencyGooglePlace = typeof agencyGooglePlace.$inferSelect;
export type SearchEmbedding = typeof searchEmbedding.$inferSelect;
