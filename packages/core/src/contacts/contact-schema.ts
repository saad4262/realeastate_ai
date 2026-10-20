import { z } from 'zod';
import { propertyDraftSchema } from '../listings/listing-schema';

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

/** The profile's tabs. In the URL as `?tab=`; anything else is the overview. */
export const CONTACT_TABS = [
  'overview',
  'timeline',
  'properties',
  'emails',
  'enquiries',
  'notes',
  'calendar',
  'reviews',
] as const;
export type ContactTab = (typeof CONTACT_TABS)[number];
export function parseContactTab(raw: unknown): ContactTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (CONTACT_TABS as readonly string[]).includes(v as string) ? (v as ContactTab) : 'overview';
}
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;
