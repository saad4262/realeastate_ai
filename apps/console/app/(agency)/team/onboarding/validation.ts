import {
  draftFieldErrors,
  type DraftFieldErrors,
  type InviteAgentDraft,
} from '@repo/core/team/schema';
import type { WizardStep } from './wizard-chrome';

export type DraftField = keyof InviteAgentDraft;

/**
 * Which contract fields each wizard step is answerable for. The rules
 * themselves stay in inviteAgentDraftSchema — this only decides where a
 * failure is shown, so a bad phone is caught on step 1 and not at dispatch.
 * Steps 4 and 5 review the whole draft.
 */
const STEP_FIELDS: Record<WizardStep, DraftField[] | 'all'> = {
  1: [
    'firstName',
    'lastName',
    'displayName',
    'email',
    'phone',
    'licenceNumber',
    'licenceClass',
    'licenceExpiry',
    'photoUrl',
  ],
  2: [
    'territorySuburbs',
    'territoryRadiusKm',
    'specialties',
    'commissionTier',
    'commissionSplitAgent',
    'commissionSplitAgency',
  ],
  3: ['operationalRole', 'permissionFlags', 'languages', 'bio'],
  4: 'all',
  5: 'all',
};

export function fieldsForStep(step: WizardStep): DraftField[] | 'all' {
  return STEP_FIELDS[step];
}

/** Errors this step is responsible for; {} when the step is complete. */
export function errorsForStep(
  draft: InviteAgentDraft,
  step: WizardStep,
): DraftFieldErrors {
  const all = draftFieldErrors(draft);
  const fields = STEP_FIELDS[step];
  if (fields === 'all') return all;

  const scoped: DraftFieldErrors = {};
  for (const field of fields) {
    const message = all[field];
    if (message) scoped[field] = message;
  }
  return scoped;
}

export function firstErrorField(errors: DraftFieldErrors): DraftField | undefined {
  return Object.keys(errors)[0] as DraftField | undefined;
}

export function errorSummary(errors: DraftFieldErrors): {
  count: number;
  title: string;
  description?: string;
} {
  const fields = Object.keys(errors) as DraftField[];
  const first = fields[0];
  return {
    count: fields.length,
    title:
      fields.length === 1
        ? 'One field needs attention'
        : `${fields.length} fields need attention`,
    description: first ? errors[first] : undefined,
  };
}

/** Which step owns a field — used to send a server-side error back to it. */
export function stepForField(field: DraftField): WizardStep {
  for (const step of [1, 2, 3] as const) {
    const fields = STEP_FIELDS[step];
    if (fields !== 'all' && fields.includes(field)) return step;
  }
  return 1;
}

export const STEP_HREFS: Record<WizardStep, string> = {
  1: '/team/onboarding',
  2: '/team/onboarding/territory',
  3: '/team/onboarding/permissions',
  4: '/team/onboarding/review',
  5: '/team/onboarding/dispatch',
};
