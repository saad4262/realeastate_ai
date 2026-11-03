import { z } from 'zod';
import { AU_DUTY_STATES, type DutySource } from './duty-rates';
import { estimateStampDuty, type DutyEstimate } from './stamp-duty';

/**
 * Affordability AI (ADR 0080, C1; mock docs/mocks/consumer-affordability.html, the six decisions taken as
 * recommended on 2026-11-03). Repayments, the cash needed upfront and what the buyer could borrow, from what
 * they typed and each state's published duty rates. Pure: no database, no model. The guide is handed these
 * figures as a tool result and only explains them (#4). An estimate, never advice (decision 1).
 */

/**
 * Lenders test a loan at its rate plus this many percentage points (APRA's serviceability buffer;
 * decision 2). Kept at 3 by APRA on 28 May 2026.
 */
export const SERVICEABILITY_BUFFER_PCT = 3;
export const BUFFER_SOURCE: DutySource = { name: 'APRA — macroprudential settings (serviceability buffer)', url: 'https://www.apra.gov.au/news-and-publications/apra-announces-update-on-macroprudential-settings', checkedOn: '2026-11-03' };

/** Under this share of the price as deposit, lenders mortgage insurance may apply (decision 3: said, never priced). */
export const LMI_DEPOSIT_SHARE = 0.2;

/** The rate rises every answer shows beside the buyer's own rate. */
export const RATE_RISES_PCT = [1, 2] as const;

const money = (max: number) => z.number().int().min(0).max(max);

export const affordabilityInputSchema = z
  .object({
    price: z.number().int().positive().max(100_000_000),
    state: z.enum(AU_DUTY_STATES),
    propertyKind: z.enum(['established', 'new', 'vacant_land']),
    ownerOccupier: z.boolean(),
    firstHome: z.boolean(),
    deposit: money(100_000_000),
    ratePct: z.number().min(0).max(25),
    termYears: z.number().int().min(1).max(40),
    repayment: z.enum(['pi', 'io']),
    /** Conveyancing, inspections… the buyer's own figure (decision 3). */
    otherCosts: money(10_000_000),
    /** The budget, all three or none. Never saved, never sent to the model (decision 5). */
    budget: z
      .object({ takeHomeMonthly: money(10_000_000), livingMonthly: money(10_000_000), otherRepaymentsMonthly: money(10_000_000) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => !v.firstHome || v.ownerOccupier, { message: 'A first home buyer must live in the home', path: ['ownerOccupier'] });

export type AffordabilityInput = z.infer<typeof affordabilityInputSchema>;

export type Affordability = {
  loan: number;
  /** The buyer's own repayment type, at their rate. */
  monthly: number;
  /** Principal and interest at the buyer's rate plus each rise. */
  rises: { ratePct: number; monthly: number }[];
  /** Over the whole term, principal and interest. */
  totalInterest: number;
  duty: DutyEstimate;
  upfront: { deposit: number; duty: number | null; otherCosts: number; total: number | null };
  lmiMayApply: boolean;
  borrowing: null | {
    surplusMonthly: number;
    assessmentRatePct: number;
    capacity: number;
    /** The capacity covers this loan. */
    covers: boolean;
    /** The dearest home this deposit and capacity reach, after duty and other costs; rounded down to $5,000. */
    maxPrice: number;
    /** False where the state's duty is not verified: then `maxPrice` leaves duty out, and says so. */
    maxPriceIncludesDuty: boolean;
  };
  sources: DutySource[];
};

const cents = (n: number) => Math.round(n * 100) / 100;

/** The monthly payment that clears `principal` over `years` at `ratePct` a year. */
export function monthlyRepayment(principal: number, ratePct: number, years: number): number {
  if (principal <= 0) return 0;
  const r = ratePct / 100 / 12;
  const n = years * 12;
  return cents(r === 0 ? principal / n : (principal * r) / (1 - (1 + r) ** -n));
}

export function interestOnlyRepayment(principal: number, ratePct: number): number {
  return cents(Math.max(0, principal) * (ratePct / 100 / 12));
}

/** The principal a monthly payment clears over `years` at `ratePct` — the inverse of `monthlyRepayment`. */
export function principalFor(monthly: number, ratePct: number, years: number): number {
  if (monthly <= 0) return 0;
  const r = ratePct / 100 / 12;
  const n = years * 12;
  return r === 0 ? monthly * n : (monthly * (1 - (1 + r) ** -n)) / r;
}

/**
 * The dearest price where deposit + capacity pays the price, its duty and the other costs. Price plus duty
 * never falls as the price rises (a concession that ends adds duty, never removes it), so a search over
 * $1,000 steps is exact to the step.
 */
function maxPriceFor(input: AffordabilityInput, capacity: number): { price: number; withDuty: boolean } {
  const cash = input.deposit + capacity - input.otherCosts;
  if (cash <= 0) return { price: 0, withDuty: true };
  const dutyAt = (price: number) => {
    const d = estimateStampDuty({ state: input.state, value: price, ownerOccupier: input.ownerOccupier, firstHome: input.firstHome, propertyKind: input.propertyKind });
    return d.status === 'estimate' ? d.duty : null;
  };
  if (dutyAt(Math.max(1_000, Math.floor(cash / 2))) === null) return { price: Math.floor(cash / 5_000) * 5_000, withDuty: false };
  let lo = 0;
  let hi = Math.floor(cash / 1_000);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const price = mid * 1_000;
    const duty = dutyAt(price);
    if (duty !== null && price + duty <= cash) lo = mid;
    else hi = mid - 1;
  }
  return { price: Math.floor((lo * 1_000) / 5_000) * 5_000, withDuty: true };
}

export function estimateAffordability(raw: AffordabilityInput): Affordability {
  const input = affordabilityInputSchema.parse(raw);
  const loan = Math.max(0, input.price - input.deposit);
  const duty = estimateStampDuty({ state: input.state, value: input.price, ownerOccupier: input.ownerOccupier, firstHome: input.firstHome, propertyKind: input.propertyKind });
  const dutyAmount = duty.status === 'estimate' ? duty.duty : null;
  const pi = monthlyRepayment(loan, input.ratePct, input.termYears);

  let borrowing: Affordability['borrowing'] = null;
  if (input.budget) {
    const { takeHomeMonthly, livingMonthly, otherRepaymentsMonthly } = input.budget;
    const surplusMonthly = Math.max(0, takeHomeMonthly - livingMonthly - otherRepaymentsMonthly);
    const assessmentRatePct = cents(input.ratePct + SERVICEABILITY_BUFFER_PCT);
    // Assessed as principal and interest whatever the buyer picked, as lenders do.
    const capacity = Math.floor(principalFor(surplusMonthly, assessmentRatePct, input.termYears) / 1_000) * 1_000;
    const max = maxPriceFor(input, capacity);
    borrowing = { surplusMonthly, assessmentRatePct, capacity, covers: capacity >= loan, maxPrice: max.price, maxPriceIncludesDuty: max.withDuty };
  }

  return {
    loan,
    monthly: input.repayment === 'io' ? interestOnlyRepayment(loan, input.ratePct) : pi,
    rises: RATE_RISES_PCT.map((rise) => ({ ratePct: cents(input.ratePct + rise), monthly: monthlyRepayment(loan, input.ratePct + rise, input.termYears) })),
    totalInterest: Math.round(pi * input.termYears * 12 - loan),
    duty,
    upfront: { deposit: input.deposit, duty: dutyAmount, otherCosts: input.otherCosts, total: dutyAmount === null ? null : cents(input.deposit + dutyAmount + input.otherCosts) },
    lmiMayApply: loan > 0 && input.deposit < input.price * LMI_DEPOSIT_SHARE,
    borrowing,
    sources: [...duty.sources, ...(borrowing ? [BUFFER_SOURCE] : [])],
  };
}
