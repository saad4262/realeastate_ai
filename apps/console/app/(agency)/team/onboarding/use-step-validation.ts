'use client';

import { useCallback, useMemo, useState } from 'react';
import type { DraftFieldErrors } from '@repo/core/team/schema';
import { useToast } from '@/components/toast';
import { useOnboarding } from './onboarding-state';
import {
  errorSummary,
  errorsForStep,
  firstErrorField,
  type DraftField,
} from './validation';
import type { WizardStep } from './wizard-chrome';

export type StepValidation = {
  errors: DraftFieldErrors;
  isValid: boolean;
  /** Message to render under a field — only once it has been touched. */
  errorFor: (field: DraftField) => string | undefined;
  markTouched: (field: DraftField) => void;
  /** Call from onNext: false blocks navigation and surfaces what is wrong. */
  guardNext: () => boolean;
};

function focusField(field: DraftField) {
  if (typeof document === 'undefined') return;
  const el = document.querySelector<HTMLElement>(`[data-field="${field}"]`);
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el?.focus({ preventScroll: true });
}

/**
 * Wizard-step validation against the shared zod contract. Errors stay quiet
 * until a field is blurred or the user tries to continue, so a half-typed
 * form is not shouting at them.
 */
export function useStepValidation(step: WizardStep): StepValidation {
  const { draft } = useOnboarding();
  const { toast } = useToast();
  const [touched, setTouched] = useState<Partial<Record<DraftField, boolean>>>({});
  const [revealAll, setRevealAll] = useState(false);

  const errors = useMemo(() => errorsForStep(draft, step), [draft, step]);
  const isValid = Object.keys(errors).length === 0;

  const errorFor = useCallback(
    (field: DraftField) =>
      revealAll || touched[field] ? errors[field] : undefined,
    [errors, revealAll, touched],
  );

  const markTouched = useCallback((field: DraftField) => {
    setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
  }, []);

  const guardNext = useCallback(() => {
    if (isValid) return true;

    setRevealAll(true);
    const { title, description } = errorSummary(errors);
    toast({ variant: 'error', title, description });

    const field = firstErrorField(errors);
    if (field) focusField(field);
    return false;
  }, [errors, isValid, toast]);

  return { errors, isValid, errorFor, markTouched, guardNext };
}
