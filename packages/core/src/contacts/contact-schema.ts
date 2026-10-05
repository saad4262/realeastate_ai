import { z } from 'zod';

/**
 * The contracts for contacts (docs/adr/0018).
 *
 * zod and nothing else, so the console's forms can import them and refuse a
 * bad field before a round trip. The vocabularies below are copies of the
 * database enums, and `contact-schema.test.ts` fails the moment they differ —
 * the same arrangement as the schedule vocabularies.
 */

export const CONTACT_ROLES = ['seller', 'buyer', 'landlord', 'tenant', 'investor'] as const;
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
] as const;
export const activityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const CONTACT_ROLE_LABELS: Record<ContactRoleKind, string> = {
  seller: 'Seller',
  buyer: 'Buyer',
  landlord: 'Landlord',
  tenant: 'Tenant',
  investor: 'Investor',
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
  page: z.coerce.number().int().min(1).max(10_000).default(1).catch(1),
});
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;
