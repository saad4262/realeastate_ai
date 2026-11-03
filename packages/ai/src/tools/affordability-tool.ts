import { z } from 'zod';
import { AU_DUTY_STATES, estimateStampDuty, interestOnlyRepayment, monthlyRepayment, RATE_RISES_PCT } from '@repo/core/affordability';
import type { ToolOutcome } from './context';

/**
 * Affordability AI in the guide (ADR 0080, C1 decision 6c). Every figure is computed in core from the
 * state's published rates and handed to the model as text it copies — never a number it works out (#4).
 * No income, expenses or borrowing here: the budget is never sent to the model (decision 5); the visitor
 * is pointed to the Affordability page for that.
 */
export const affordabilityInput = z
  .object({
    state: z.enum(AU_DUTY_STATES),
    price: z.number().int().positive().max(100_000_000),
    buyer: z.enum(['first', 'home', 'investor']),
    propertyKind: z.enum(['established', 'new', 'vacant_land']).optional(),
    /** Only what the visitor said. Repayments are shown only when both of these were given. */
    deposit: z.number().int().min(0).max(100_000_000).optional(),
    ratePct: z.number().min(0).max(25).optional(),
    termYears: z.number().int().min(1).max(40).optional(),
  })
  /** Unknown keys are stripped, not refused — see search-listings-tool.ts. */
  .strip();

export type AffordabilityToolInput = z.infer<typeof affordabilityInput>;

const aud = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 0, maximumFractionDigits: n % 1 ? 2 : 0 });

export function runAffordability(input: AffordabilityToolInput): ToolOutcome {
  const kind = input.propertyKind ?? 'established';
  const duty = estimateStampDuty({ state: input.state, value: input.price, ownerOccupier: input.buyer !== 'investor', firstHome: input.buyer === 'first', propertyKind: kind });
  const source = duty.sources[0]!;

  const stampDuty =
    duty.status === 'estimate'
      ? {
          amount: aud(duty.duty),
          atGeneralRate: duty.generalDuty === null ? null : aud(duty.generalDuty),
          saving: duty.generalDuty !== null && duty.generalDuty > duty.duty ? aud(duty.generalDuty - duty.duty) : null,
          rates: duty.applied === 'first_home' ? 'first home concession' : duty.applied === 'owner_occupier' ? 'rate for a home the buyer lives in' : 'general rates',
          approximate: !duty.exact,
          notes: duty.notes,
        }
      : { amount: null, notVerified: `We have not verified ${duty.what}. Say so, give no figure, and point to the official site.` };

  let repayments = null;
  if (input.deposit !== undefined && input.ratePct !== undefined) {
    const years = input.termYears ?? 30;
    const loan = Math.max(0, input.price - input.deposit);
    repayments = {
      loan: aud(loan),
      monthlyPrincipalAndInterest: aud(monthlyRepayment(loan, input.ratePct, years)),
      monthlyInterestOnly: aud(interestOnlyRepayment(loan, input.ratePct)),
      ifRatesRise: RATE_RISES_PCT.map((rise) => ({ rate: `${Math.round((input.ratePct! + rise) * 100) / 100}%`, monthly: aud(monthlyRepayment(loan, input.ratePct! + rise, years)) })),
      termYears: years,
      lmiMayApply: loan > 0 && input.deposit < input.price * 0.2,
    };
  }

  return {
    label: `Working out costs in ${input.state}…`,
    result: {
      state: input.state,
      price: aud(input.price),
      propertyKind: kind,
      stampDuty,
      repayments,
      source: `${source.name}, checked ${source.checkedOn}`,
      excludes: 'foreign buyer surcharge, lenders mortgage insurance, lender and legal fees',
      instruction:
        'Copy these figures exactly; never calculate, round differently or add your own. End with: "Estimate — general information only, not financial or credit advice." For what they could borrow, send them to the Affordability page — never ask for their income here.',
    },
  };
}
