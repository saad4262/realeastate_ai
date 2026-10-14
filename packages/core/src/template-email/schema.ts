import { z } from 'zod';

/**
 * Template email contracts (docs/adr/0022). Pure: the console's editor uses
 * the same checks the server does.
 */

/** The only merge fields there are. Every value comes from SQL, never a model. */
export const MERGE_FIELDS = ['first_name', 'full_name', 'agent_name', 'agency_name'] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Record<MergeField, string>;

/** Merge fields a text uses that do not exist — `{{suburb}}`, a typo, a stray brace. */
export function unknownMergeFields(text: string): string[] {
  const bad = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    if (!(MERGE_FIELDS as readonly string[]).includes(m[1]!)) bad.add(m[1]! || '(empty)');
  }
  const stray = text.replace(/\{\{\s*[^}]*?\s*\}\}/g, '');
  if (/\{\{|\}\}/.test(stray)) bad.add('an unclosed {{ or }}');
  return [...bad];
}

export function renderMerge(text: string, values: MergeValues): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, key: string) =>
    (MERGE_FIELDS as readonly string[]).includes(key) ? values[key as MergeField] : all,
  );
}

const mergeChecked = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `Write the ${what}`)
    .max(max)
    .superRefine((v, ctx) => {
      const bad = unknownMergeFields(v);
      if (bad.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown merge field: ${bad.join(', ')}. Use ${MERGE_FIELDS.map((f) => `{{${f}}}`).join(', ')}.` });
    });

export const templateInputSchema = z.object({
  name: z.string().trim().min(2, 'Give the template a name').max(80),
  subject: mergeChecked(160, 'subject'),
  body: mergeChecked(8000, 'email'),
});
export type TemplateInput = z.input<typeof templateInputSchema>;

export const TEMPLATE_STATUS_LABELS = {
  draft: 'Draft',
  pending_approval: 'Waiting for approval',
  approved: 'Ready',
  retired: 'Retired',
} as const;

/** Why a contact is not sent to — every one is shown before approval. */
export const SKIP_REASONS = [
  'opted_out',
  'archived',
  'recently_emailed',
  'no_consent',
  'no_email',
  'batch_limit',
  'dev_allowlist',
  'email_changed',
  'daily_limit',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  opted_out: 'Opted out of marketing email',
  archived: 'Archived',
  // ADR 0043 removed the 7-day rule; only batches made before it carry this reason.
  recently_emailed: 'Already sent a template email in the last 7 days (an old rule)',
  no_consent: 'No marketing consent — none recorded, no enquiry in the last 24 months, not a client',
  no_email: 'No email address',
  batch_limit: 'Over the per-batch limit',
  dev_allowlist: 'Not on the development allowlist (nothing real is sent in development)',
  email_changed: 'Their email address changed since Prepare',
  daily_limit: 'Daily sending limit reached',
};

export const BATCH_STATUS_LABELS = {
  prepared: 'Prepared — waiting for approval',
  approved_sending: 'Sending',
  sent: 'Sent',
  expired: 'Expired — prepare again',
  cancelled: 'Cancelled',
} as const;

export const BATCH_TTL_MS = 48 * 60 * 60 * 1000;
