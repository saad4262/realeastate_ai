import { z } from 'zod';
import { PROPERTY_TYPES, propertyDraftSchema, type PropertyType } from '../listings/listing-schema';

/**
 * The contracts for contacts (docs/adr/0018).
 *
 * zod and nothing else, so the console's forms can import them and refuse a
 * bad field before a round trip. The vocabularies below are copies of the
 * database enums, and `contact-schema.test.ts` fails the moment they differ —
 * the same arrangement as the schedule vocabularies.
 */

/**
 * What a person is to the agency (ADR 0018); one may hold several. Prospect, past client and referral
 * partner (ADR 0061) are relationships only — none of them is a client role for marketing consent
 * (CLIENT_ROLES in template-email/consent.ts stays seller, landlord, tenant).
 */
export const CONTACT_ROLES = ['seller', 'buyer', 'landlord', 'tenant', 'investor', 'prospect', 'past_client', 'referral_partner'] as const;
export type ContactRoleKind = (typeof CONTACT_ROLES)[number];

export const CONTACT_SOURCES = ['enquiry', 'offer', 'email', 'manual', 'import'] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export const CONTACT_PROPERTY_RELATIONS = [
  'owner',
  'vendor',
  'landlord',
  'tenant',
  'interested',
  'other',
] as const;
export type ContactPropertyRelation = (typeof CONTACT_PROPERTY_RELATIONS)[number];

/**
 * What `activity.kind` may say. Text in the database, checked here, so adding
 * a kind is a code change rather than an enum migration.
 */
export const ACTIVITY_KINDS = [
  'contact_created',
  'contact_updated',
  'contact_assigned',
  'contact_merged',
  'role_added',
  'role_removed',
  'consent_recorded',
  'consent_withdrawn',
  'contact_archived',
  'contact_restored',
  'property_linked',
  'property_unlinked',
  'appointment_scheduled',
  'appointment_rescheduled',
  'appointment_completed',
  'appointment_cancelled',
  'appointment_invitation_sent',
  // The contact was emailed the new details of a moved appointment, or told it was cancelled.
  'appointment_update_sent',
  'appointment_cancellation_sent',
  'template_email_sent',
  // ADR 0035: a new email written to them (by a person, or approved on an assistant card).
  'email_sent',
  'contact_opted_out',
  // The console assistant (ADR 0025): a card proposed, and what became of it.
  'assistant_proposed',
  'assistant_approved',
  'assistant_rejected',
  'assistant_cancelled',
  // Offboarding (ADR 0030): their person left the agency; the Zoom link changed with it.
  'owner_left',
  'zoom_link_changed',
  'assistant_failed',
  // ADR 0055: what they are looking for.
  'requirement_added',
  'requirement_updated',
  'requirement_removed',
] as const;
export const activityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const CONTACT_ROLE_LABELS: Record<ContactRoleKind, string> = {
  seller: 'Seller',
  buyer: 'Buyer',
  landlord: 'Landlord',
  tenant: 'Tenant',
  investor: 'Investor',
  prospect: 'Prospect',
  past_client: 'Past client',
  referral_partner: 'Referral partner',
};

export const CONTACT_PROPERTY_RELATION_LABELS: Record<ContactPropertyRelation, string> = {
  owner: 'Owner',
  vendor: 'Selling',
  landlord: 'Landlord',
  tenant: 'Tenant',
  interested: 'Interested',
  other: 'Other',
};

/** What each timeline entry from `activity` says, in words. */
export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  contact_created: 'Contact added',
  contact_updated: 'Details changed',
  contact_assigned: 'Assigned',
  owner_left: 'Their agent left the agency',
  zoom_link_changed: 'Zoom link changed — resend the invitation',
  contact_merged: 'Merged with a duplicate',
  role_added: 'Role added',
  role_removed: 'Role removed',
  consent_recorded: 'Marketing consent recorded',
  consent_withdrawn: 'Marketing consent withdrawn',
  contact_archived: 'Archived',
  contact_restored: 'Restored from the archive',
  property_linked: 'Property linked',
  property_unlinked: 'Property unlinked',
  appointment_scheduled: 'Appointment booked',
  appointment_rescheduled: 'Appointment moved',
  appointment_completed: 'Appointment completed',
  appointment_cancelled: 'Appointment cancelled',
  appointment_invitation_sent: 'Invitation emailed',
  appointment_update_sent: 'New appointment details emailed',
  appointment_cancellation_sent: 'Cancellation emailed',
  template_email_sent: 'Template email sent',
  email_sent: 'Email sent',
  contact_opted_out: 'Unsubscribed from marketing email',
  assistant_proposed: 'Assistant suggested a change',
  assistant_approved: 'Assistant change approved',
  assistant_rejected: 'Assistant change rejected',
  assistant_cancelled: 'Assistant change cancelled',
  assistant_failed: 'Assistant change could not be made',
  requirement_added: 'Requirements added',
  requirement_updated: 'Requirements changed',
  requirement_removed: 'Requirements removed',
};

export const CONTACT_SOURCE_LABELS: Record<ContactSource, string> = {
  enquiry: 'Enquiry',
  offer: 'Private offer',
  email: 'Email',
  manual: 'Added by hand',
  import: 'Import',
};

/** Blank → undefined, so "" never reaches a nullable column as an empty string. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/**
 * One person's details, as a form sends them. Phone is not shaped by a regex —
 * the enquiry form's reasoning: Australians write numbers a dozen ways, and a
 * refused real number is a lost contact. Email is lower-cased because that is
 * how the database matches people.
 */
export const contactFieldsSchema = z.object({
  name: z.string().trim().min(1, 'Give them a name').max(120),
  email: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v.toLowerCase() : undefined))
    .pipe(z.string().email('That does not look like an email address').optional()),
  phone: optionalText(40),
  roles: z.array(z.enum(CONTACT_ROLES)).max(CONTACT_ROLES.length).default([]),
  nextAction: optionalText(300),
  /** ISO date-time, or blank. */
  nextActionAt: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.coerce.date().optional()),
  /**
   * The agent says this person agreed to marketing email. Recorded with who
   * and when; unticking withdraws it. An enquiry never sets this (ADR 0018).
   */
  marketingConsent: z.boolean().default(false),
  marketingConsentNote: optionalText(300),
});

export const createContactSchema = contactFieldsSchema
  .extend({
    /** An admin may hand it to somebody; anybody else's new contact is their own. */
    assignedTo: z.string().uuid().optional(),
  })
  .refine((v) => v.email || v.phone, {
    message: 'Give an email or a phone number, so they can be reached',
    path: ['email'],
  });

export const updateContactSchema = contactFieldsSchema;

export type CreateContactInput = z.input<typeof createContactSchema>;
export type UpdateContactInput = z.input<typeof updateContactSchema>;

/** The directory's filters, from the URL. Anything unrecognised is dropped, not refused. */
export const CONTACT_PAGE_SIZE = 25;

export const contactListQuerySchema = z.object({
  q: z.string().trim().max(120).optional().catch(undefined),
  role: z.enum(CONTACT_ROLES).optional().catch(undefined),
  source: z.enum(CONTACT_SOURCES).optional().catch(undefined),
  /** `me`, `none`, or a member's id. Only an admin's directory offers others. */
  assigned: z
    .union([z.literal('me'), z.literal('none'), z.string().uuid()])
    .optional()
    .catch(undefined),
  /** Archived contacts are hidden unless asked for. */
  archived: z.enum(['archived', 'all']).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).default(1).catch(1),
});

/** A note, as the composer sends it. */
export const MAX_NOTE_LENGTH = 5000;
export const noteBodySchema = z
  .string()
  .transform((v) => v.replace(/\r\n?/g, '\n').trim())
  .pipe(
    z
      .string()
      .min(1, 'Write something first')
      .max(MAX_NOTE_LENGTH, `Keep a note under ${MAX_NOTE_LENGTH.toLocaleString('en-AU')} characters`),
  );

/** Tie a contact to an address. */
export const linkPropertySchema = z.object({
  propertyId: z.string().uuid(),
  relation: z.enum(CONTACT_PROPERTY_RELATIONS),
  note: optionalText(300),
});
export type LinkPropertyInput = z.input<typeof linkPropertySchema>;

/**
 * Tie a contact to an address the system has never seen — an owner's or
 * vendor's home that is not listed. The listing form's own address rules
 * (`propertyDraftSchema`: suburb, state, 4-digit postcode, the pin from the
 * address picker), plus a street, because a home has one. No physical facts:
 * a contact link says who, not what the house is.
 */
export const linkNewAddressSchema = propertyDraftSchema
  .pick({
    unit: true,
    streetNumber: true,
    suburb: true,
    state: true,
    postcode: true,
    latitude: true,
    longitude: true,
    placeId: true,
    pinSource: true,
    formattedAddress: true,
  })
  .extend({
    street: z.string().trim().min(1, 'Street is required').max(200),
    relation: z.enum(CONTACT_PROPERTY_RELATIONS),
    note: optionalText(300),
  });
export type LinkNewAddressInput = z.input<typeof linkNewAddressSchema>;

/** The next-action quick edit on the overview. */
export const nextActionSchema = z.object({
  nextAction: optionalText(300),
  nextActionAt: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.coerce.date().optional()),
});
export type NextActionInput = z.input<typeof nextActionSchema>;

// ── Buyer requirements (ADR 0055) ──────────────────────────────────────────

/** What a brief is for. A subset of listing_channel: nobody is looking to buy a sold listing. */
export const REQUIREMENT_CHANNELS = ['sale', 'rent'] as const;
export type RequirementChannel = (typeof REQUIREMENT_CHANNELS)[number];
export const REQUIREMENT_CHANNEL_LABELS: Record<RequirementChannel, string> = { sale: 'Buying', rent: 'Renting' };

export const REQUIREMENT_STATUSES = ['active', 'paused'] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** A contact holds at most this many briefs — a home, an investment, a fallback; not a search history. */
export const MAX_REQUIREMENTS_PER_CONTACT = 10;
export const MAX_REQUIREMENT_SUBURBS = 20;
export const MAX_REQUIREMENT_NOTE = 1000;

/**
 * A number from a form box or from code: blank → undefined, "850,000" and "$850000" → 850000.
 * Never a shorthand ("850k", "1.2m") — a figure is the agent's, never guessed (#4).
 */
const optionalNumber = (label: string, max: number, opts: { int?: boolean; step?: number } = {}) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const raw = typeof v === 'number' ? v : v.replace(/[\s,$]/g, '');
      if (raw === '') return undefined;
      const n = typeof raw === 'number' ? raw : /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a number from 0 to ${max.toLocaleString('en-AU')}` });
        return z.NEVER;
      }
      if (opts.int && !Number.isInteger(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a whole number` });
        return z.NEVER;
      }
      if (opts.step && Math.round(n / opts.step) * opts.step !== n) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} goes in steps of ${opts.step}` });
        return z.NEVER;
      }
      return n;
    });

/** "bondi  beach" → "Bondi Beach": one spelling per suburb, so a brief reads as the listing does. */
function suburbName(v: string): string {
  return v
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());
}

/**
 * One brief, as the form or the assistant sends it. Every bound is optional — null means "any" —
 * but a brief must say SOMETHING: one with no bound at all would match every listing the agency has.
 */
export const buyerRequirementSchema = z
  .object({
    channel: z.enum(REQUIREMENT_CHANNELS).default('sale'),
    priceMin: optionalNumber('The lowest price', 100_000_000),
    priceMax: optionalNumber('The highest price', 100_000_000),
    minBedrooms: optionalNumber('Bedrooms', 20, { int: true }),
    minBathrooms: optionalNumber('Bathrooms', 20, { step: 0.5 }),
    suburbs: z
      .array(z.string().trim().min(1).max(80, 'A suburb name is at most 80 characters'))
      .max(MAX_REQUIREMENT_SUBURBS, `At most ${MAX_REQUIREMENT_SUBURBS} suburbs`)
      .default([])
      // Case-insensitive de-duplication: "Bondi" and "bondi" are one suburb.
      .transform((list) => [...new Map(list.map((s) => suburbName(s)).map((s) => [s.toLowerCase(), s])).values()]),
    propertyTypes: z
      .array(z.string().trim().toLowerCase().pipe(z.enum(PROPERTY_TYPES, { errorMap: () => ({ message: 'Choose property types from the list' }) })))
      .max(PROPERTY_TYPES.length)
      .default([])
      .transform((list): PropertyType[] => [...new Set(list)]),
    note: optionalText(MAX_REQUIREMENT_NOTE),
    status: z.enum(REQUIREMENT_STATUSES).default('active'),
  })
  .refine((v) => v.priceMin === undefined || v.priceMax === undefined || v.priceMin <= v.priceMax, {
    message: 'The lowest price is above the highest',
    path: ['priceMax'],
  })
  .refine(
    (v) =>
      v.priceMin !== undefined ||
      v.priceMax !== undefined ||
      v.minBedrooms !== undefined ||
      v.minBathrooms !== undefined ||
      v.suburbs.length > 0 ||
      v.propertyTypes.length > 0,
    { message: 'Give at least one thing they are looking for — a price, bedrooms, a suburb or a type', path: ['priceMin'] },
  );
export type BuyerRequirementInput = z.input<typeof buyerRequirementSchema>;
export type BuyerRequirementValues = z.output<typeof buyerRequirementSchema>;

/** The figures of a saved brief, as they come back from the database. */
export type RequirementFacts = {
  channel: RequirementChannel;
  priceMin: number | null;
  priceMax: number | null;
  minBedrooms: number | null;
  minBathrooms: number | null;
  suburbs: string[];
  propertyTypes: string[];
};

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

/** "$800,000 – $1,200,000", "up to $650/wk", "from $1,000,000", or null for any price. */
export function requirementPriceText(r: Pick<RequirementFacts, 'channel' | 'priceMin' | 'priceMax'>): string | null {
  const per = r.channel === 'rent' ? '/wk' : '';
  const f = (n: number) => `${AUD.format(n)}${per}`;
  if (r.priceMin !== null && r.priceMax !== null) return r.priceMin === r.priceMax ? f(r.priceMin) : `${f(r.priceMin)} – ${f(r.priceMax)}`;
  if (r.priceMax !== null) return `up to ${f(r.priceMax)}`;
  if (r.priceMin !== null) return `from ${f(r.priceMin)}`;
  return null;
}

/**
 * One line a person can read: "Buying · $800,000 – $1,200,000 · 3+ bed · 2+ bath · House, Townhouse ·
 * Bondi, Coogee". Rendered from the stored figures only — the timeline, the profile and (later) a
 * match alert all say a brief the same way, and no model writes it.
 */
export function describeRequirement(r: RequirementFacts): string {
  const parts = [REQUIREMENT_CHANNEL_LABELS[r.channel]];
  const price = requirementPriceText(r);
  if (price) parts.push(price);
  if (r.minBedrooms !== null) parts.push(`${r.minBedrooms}+ bed`);
  if (r.minBathrooms !== null) parts.push(`${r.minBathrooms}+ bath`);
  if (r.propertyTypes.length) parts.push(r.propertyTypes.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(', '));
  parts.push(r.suburbs.length ? r.suburbs.join(', ') : 'any suburb');
  return parts.join(' · ');
}

/** The profile's tabs. In the URL as `?tab=`; anything else is the overview. */
export const CONTACT_TABS = [
  'overview',
  'requirements',
  'timeline',
  'properties',
  'emails',
  'enquiries',
  'notes',
  'documents',
  'calendar',
  'reviews',
] as const;
export type ContactTab = (typeof CONTACT_TABS)[number];
export function parseContactTab(raw: unknown): ContactTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (CONTACT_TABS as readonly string[]).includes(v as string) ? (v as ContactTab) : 'overview';
}
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;
