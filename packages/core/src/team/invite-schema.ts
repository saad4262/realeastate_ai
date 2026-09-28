import { z } from 'zod';
import { storageKeySchema } from '../media/storage-key';
import type { MembershipRole } from '../permissions';

/** Maps wizard operational presets → membership.role (never check role strings in UI). */
export const operationalRoleSchema = z.enum([
  'senior',
  'principal',
  'pm',
  'cadet',
  'custom',
]);

export type OperationalRole = z.infer<typeof operationalRoleSchema>;

export function membershipRoleFromOperational(
  role: OperationalRole,
): MembershipRole {
  switch (role) {
    case 'principal':
      return 'admin';
    case 'pm':
      return 'property_manager';
    case 'cadet':
      return 'assistant';
    case 'senior':
    case 'custom':
    default:
      return 'agent';
  }
}

export const commissionTierSchema = z.enum(['t1', 't2', 't3']);

/** Digits only — "+61 418 920 441" → "61418920441". */
export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

const PHONE_SHAPE = /^\+?[0-9 ()\-.]+$/;

/**
 * Phone is validated on digit count, not string length — "+61 4189" is 8
 * characters but only 7 digits, and a raw .min(8) on the string let it through.
 */
export const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Mobile number is required')
  .max(32, 'Mobile number is too long')
  .refine((v) => PHONE_SHAPE.test(v), {
    message: 'Mobile number may only contain digits, spaces and + ( ) - .',
  })
  .refine((v) => phoneDigits(v).length >= 8, {
    message: 'Mobile number needs at least 8 digits (e.g. 0418 920 441)',
  })
  .refine((v) => phoneDigits(v).length <= 15, {
    message: 'Mobile number has more than 15 digits',
  });

/**
 * Every field carries its own message: the wizard renders these verbatim under
 * the input, and the server action puts the first one in a toast.
 */
export const inviteAgentDraftSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, 'First legal name is required')
    .max(80, 'First legal name is too long'),
  lastName: z
    .string()
    .trim()
    .min(1, 'Last legal name is required')
    .max(80, 'Last legal name is too long'),
  displayName: z
    .string()
    .trim()
    .min(1, 'Display name is required')
    .max(160, 'Display name is too long'),
  email: z
    .string()
    .trim()
    .min(1, 'Agency email is required')
    .email('Enter a valid email address')
    .max(320, 'Email address is too long'),
  phone: phoneSchema,
  licenceNumber: z
    .string()
    .trim()
    .min(1, 'Fair Trading licence number is required')
    .max(64, 'Licence number is too long'),
  licenceClass: z.string().trim().max(64, 'Licence class is too long').default('Class 1'),
  licenceExpiry: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Licence expiry must be a valid date')
    .optional()
    .nullable(),
  territorySuburbs: z
    .array(z.string().trim().min(1).max(80))
    .min(1, 'Add at least one territory suburb')
    .max(20, 'A territory can hold at most 20 suburbs'),
  territoryRadiusKm: z
    .number()
    .min(0.5, 'Territory radius must be at least 0.5 km')
    .max(50, 'Territory radius cannot exceed 50 km')
    .default(8),
  specialties: z.array(z.string().trim().min(1).max(80)).default([]),
  languages: z.array(z.string().trim().min(1).max(40)).default(['en']),
  commissionTier: commissionTierSchema.default('t1'),
  commissionSplitAgent: z
    .number()
    .int()
    .min(0, 'Agent split cannot be negative')
    .max(100, 'Agent split cannot exceed 100%')
    .default(70),
  commissionSplitAgency: z
    .number()
    .int()
    .min(0, 'Agency split cannot be negative')
    .max(100, 'Agency split cannot exceed 100%')
    .default(30),
  operationalRole: operationalRoleSchema.default('senior'),
  permissionFlags: z.record(z.boolean()).default({}),
  photoUrl: z
    .union([z.string().url('Photo URL must be a full https:// link'), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  /**
   * An uploaded headshot's storage key, from the wizard's upload control.
   *
   * Validated as a key this platform issued rather than as free text — it has
   * been to a browser and back, and a path is exactly the thing not to trust
   * on the way in. Preferred over photoUrl by everything that renders it.
   */
  photoKey: z
    .union([storageKeySchema, z.literal(''), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  bio: z
    .union([z.string().max(4000, 'Bio is too long'), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
});

export type InviteAgentDraft = z.infer<typeof inviteAgentDraftSchema>;

export const TIER_SPLITS: Record<
  z.infer<typeof commissionTierSchema>,
  { agent: number; agency: number; label: string }
> = {
  t1: { agent: 70, agency: 30, label: 'Tier 1 · Senior Partner' },
  t2: { agent: 60, agency: 40, label: 'Tier 2 · Sales Partner' },
  t3: { agent: 50, agency: 50, label: 'Tier 3 · Associate' },
};

export function slugifyAgentName(displayName: string, licenceNumber: string): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  const lic = licenceNumber.replace(/\D/g, '').slice(-6) || 'agent';
  return `${base || 'agent'}-${lic}`;
}

/* ------------------------------------------------------------------ *
 * Invite errors — one vocabulary shared by core, the server action
 * and the wizard, so the UI never has to string-match a message.
 * ------------------------------------------------------------------ */

export type InviteErrorCode =
  | 'forbidden'
  | 'invalid_draft'
  | 'self_invite'
  | 'already_member'
  | 'invite_pending'
  | 'unknown';

export class InviteAgentError extends Error {
  readonly code: InviteErrorCode;
  /** Draft field the message belongs to, so the wizard can jump to it. */
  readonly field?: keyof InviteAgentDraft;

  constructor(code: InviteErrorCode, message: string, field?: keyof InviteAgentDraft) {
    super(message);
    this.name = 'InviteAgentError';
    this.code = code;
    this.field = field;
  }
}

/** Duck-typed: survives a second copy of the package in the module graph. */
export function isInviteAgentError(err: unknown): err is InviteAgentError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'InviteAgentError' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

function isZodIssueBag(err: unknown): err is { issues: z.ZodIssue[] } {
  return (
    typeof err === 'object' &&
    err !== null &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

export type DraftFieldErrors = Partial<Record<keyof InviteAgentDraft, string>>;

/** First message per field — one line under each input, not a stack of them. */
export function fieldErrorsFromIssues(issues: z.ZodIssue[]): DraftFieldErrors {
  const out: DraftFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (typeof key !== 'string') continue;
    const field = key as keyof InviteAgentDraft;
    if (out[field] === undefined) out[field] = issue.message;
  }
  return out;
}

/** Validate a whole draft and return errors keyed by field ({} when valid). */
export function draftFieldErrors(draft: unknown): DraftFieldErrors {
  const result = inviteAgentDraftSchema.safeParse(draft);
  return result.success ? {} : fieldErrorsFromIssues(result.error.issues);
}

/**
 * Anything thrown out of inviteAgent() as a typed error.
 * A bare ZodError used to reach the UI as its raw JSON issue array.
 */
export function toInviteAgentError(err: unknown): InviteAgentError {
  if (isInviteAgentError(err)) return err;

  if (isZodIssueBag(err)) {
    const first = err.issues[0];
    const key = first?.path[0];
    return new InviteAgentError(
      'invalid_draft',
      first?.message ?? 'This agent dossier is incomplete',
      typeof key === 'string' ? (key as keyof InviteAgentDraft) : undefined,
    );
  }

  if (err instanceof Error && err.message === 'Forbidden') {
    return new InviteAgentError(
      'forbidden',
      'You do not have permission to invite agents to this agency',
    );
  }

  return new InviteAgentError(
    'unknown',
    err instanceof Error && err.message ? err.message : 'Invite failed',
  );
}
