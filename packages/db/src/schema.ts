import { desc, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
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
    /**
     * The person behind it (ADR 0018). Set by the `lead` insert trigger through
     * `public.contact_upsert`, matched on email; nullable only so the column
     * could be added before the backfill.
     */
    contactId: uuid('contact_id').references((): AnyPgColumn => contact.id, { onDelete: 'set null' }),
    aiSummary: text('ai_summary'),
    aiIntent: text('ai_intent'),
    aiQualification: jsonb('ai_qualification'),
    ...timestamps,
  },
  (t) => [
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
    ...timestamps,
  },
  (t) => [
    index('mail_message_thread_idx').on(t.threadId, t.createdAt),
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
    ...timestamps,
  },
  (t) => [index('note_contact_idx').on(t.contactId, desc(t.createdAt))],
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
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contact.id, { onDelete: 'cascade' }),
    /** The address it is about, if any. `restrict`: a property outlives everything (#1). */
    propertyId: uuid('property_id').references(() => property.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    /** Whose appointment it is. They — and admins — may change it. */
    assignedAgentId: uuid('assigned_agent_id').references(() => user.id, { onDelete: 'set null' }),
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
    externalCalendarId: text('external_calendar_id'),
    externalCalendarProvider: varchar('external_calendar_provider', { length: 32 }),
    zoomMeetingId: text('zoom_meeting_id'),
    ...timestamps,
  },
  (t) => [
    index('appointment_agency_starts_idx').on(t.agencyId, t.startsAt),
    index('appointment_contact_starts_idx').on(t.contactId, t.startsAt),
    index('appointment_agent_starts_idx').on(t.assignedAgentId, t.startsAt),
  ],
);

// ── Integrations (docs/adr/0020) ────────────────────────────────────────────

export const integrationProviderEnum = pgEnum('integration_provider', [
  'google_calendar',
  'zoom',
  'google_sheets',
  'google_reviews',
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
    grantedScopes: text('granted_scopes').array().notNull().default(sql`'{}'::text[]`),
    status: integrationStatusEnum('status').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /** Why it is in `error`. Never contains a token. */
    lastError: text('last_error'),
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    connectedBy: uuid('connected_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('integration_account_owner_idx').on(t.provider, t.ownerType, t.ownerId),
    index('integration_account_agency_idx').on(t.agencyId),
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
  promptVersion: varchar('prompt_version', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});


// ── Skills (docs/adr/0021) ──────────────────────────────────────────────────

/** The code a skill runs. Editing a skill's Markdown never changes this. */
export const skillHandlerEnum = pgEnum('skill_handler', ['morning_brief', 'important_emails']);
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

export type User = typeof user.$inferSelect;
export type Agency = typeof agency.$inferSelect;
export type Listing = typeof listing.$inferSelect;
export type Property = typeof property.$inferSelect;
export type Membership = typeof membership.$inferSelect;
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
export type IntegrationAccount = typeof integrationAccount.$inferSelect;
export type Skill = typeof skill.$inferSelect;
export type AgentSkill = typeof agentSkill.$inferSelect;
export type SkillRun = typeof skillRun.$inferSelect;
