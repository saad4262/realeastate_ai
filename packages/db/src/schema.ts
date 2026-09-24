import {
  boolean,
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
} from 'drizzle-orm/pg-core';

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

export const leadKindEnum = pgEnum('lead_kind', ['enquiry', 'inspection', 'appraisal']);

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
    ...timestamps,
  },
  (t) => [uniqueIndex('membership_user_agency_idx').on(t.userId, t.agencyId)],
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
  photoUrl: text('photo_url'),
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
export const listing = pgTable('listing', {
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
  auctionDate: timestamp('auction_date', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  source: listingSourceEnum('source').notNull().default('portal'),
  externalRef: varchar('external_ref', { length: 128 }),
  ...timestamps,
});

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
  (t) => [primaryKey({ columns: [t.listingId, t.userId] })],
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

export const lead = pgTable('lead', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id')
    .notNull()
    .references(() => listing.id, { onDelete: 'cascade' }),
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
  assignedTo: uuid('assigned_to').references(() => user.id, { onDelete: 'set null' }),
  aiSummary: text('ai_summary'),
  aiIntent: text('ai_intent'),
  aiQualification: jsonb('ai_qualification'),
  ...timestamps,
});

export const savedSearch = pgTable('saved_search', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  query: jsonb('query').notNull(),
  frequency: varchar('frequency', { length: 32 }).default('daily'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  ...timestamps,
});

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
  promptVersion: varchar('prompt_version', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof user.$inferSelect;
export type Agency = typeof agency.$inferSelect;
export type Listing = typeof listing.$inferSelect;
export type Property = typeof property.$inferSelect;
export type Membership = typeof membership.$inferSelect;
export type ListingAgent = typeof listingAgent.$inferSelect;
export type AgentProfile = typeof agentProfile.$inferSelect;
export type AgentInvite = typeof agentInvite.$inferSelect;
