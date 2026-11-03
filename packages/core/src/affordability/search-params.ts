import { AU_DUTY_STATES, type DutyState } from './duty-rates';
import { affordabilityInputSchema, type AffordabilityInput } from './affordability';

/**
 * The Affordability page keeps its inputs in the address (decision 5: nothing saved, a scenario can be
 * bookmarked). These are the parameter names, and the reader that turns them into the contract — or says
 * what is still missing. The form's own values come back as typed, so a half-filled form keeps them.
 */
export const AFFORDABILITY_PARAMS = {
  price: 'price',
  state: 'state',
  kind: 'kind',
  /** `first` (a first home buyer who will live there), `home` (will live there) or `investor`. */
  buyer: 'buyer',
  deposit: 'deposit',
  rate: 'rate',
  term: 'term',
  repay: 'repay',
  costs: 'costs',
  pay: 'pay',
  living: 'living',
  debts: 'debts',
} as const;

export type AffordabilityForm = Record<keyof typeof AFFORDABILITY_PARAMS, string>;

export type AffordabilityRead =
  | { ok: true; input: AffordabilityInput; form: AffordabilityForm }
  | { ok: false; form: AffordabilityForm; missing: string[]; error?: string };

type Params = { get(name: string): string | null };

/** "$750,000", "750000", "750k" → 750000. Anything else → null. */
export function readAmount(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim().toLowerCase().replace(/[$,\s]/g, '');
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function readRate(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim().replace(/[%\s]/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  return Number(s);
}

export function readAffordability(params: Params): AffordabilityRead {
  const P = AFFORDABILITY_PARAMS;
  const form: AffordabilityForm = {
    price: params.get(P.price) ?? '',
    state: (params.get(P.state) ?? '').toUpperCase(),
    kind: params.get(P.kind) ?? 'established',
    buyer: params.get(P.buyer) ?? 'home',
    deposit: params.get(P.deposit) ?? '',
    rate: params.get(P.rate) ?? '',
    term: params.get(P.term) ?? '30',
    repay: params.get(P.repay) ?? 'pi',
    costs: params.get(P.costs) ?? '',
    pay: params.get(P.pay) ?? '',
    living: params.get(P.living) ?? '',
    debts: params.get(P.debts) ?? '',
  };

  const price = readAmount(form.price);
  const deposit = readAmount(form.deposit);
  const rate = readRate(form.rate);
  const missing = [
    ...(price ? [] : ['the price']),
    ...((AU_DUTY_STATES as readonly string[]).includes(form.state) ? [] : ['the state']),
    ...(deposit !== null ? [] : ['your deposit']),
    ...(rate !== null ? [] : ['an interest rate']),
  ];
  if (missing.length) return { ok: false, form, missing };

  const pay = readAmount(form.pay);
  const living = readAmount(form.living);
  const debts = readAmount(form.debts) ?? 0;
  const parsed = affordabilityInputSchema.safeParse({
    price,
    state: form.state as DutyState,
    propertyKind: (['established', 'new', 'vacant_land'] as const).find((k) => k === form.kind) ?? 'established',
    ownerOccupier: form.buyer !== 'investor',
    firstHome: form.buyer === 'first',
    deposit,
    ratePct: rate,
    termYears: Number(form.term) || 30,
    repayment: form.repay === 'io' ? 'io' : 'pi',
    otherCosts: readAmount(form.costs) ?? 0,
    ...(pay !== null && living !== null ? { budget: { takeHomeMonthly: pay, livingMonthly: living, otherRepaymentsMonthly: debts } } : {}),
  });
  if (!parsed.success) return { ok: false, form, missing: [], error: parsed.error.issues[0]?.message ?? 'Check the numbers.' };
  return { ok: true, input: parsed.data, form };
}

/** The address of a scenario, for links from a listing and from the guide. */
export function affordabilityPath(input: Partial<Record<keyof typeof AFFORDABILITY_PARAMS, string | number>>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== '') q.set(AFFORDABILITY_PARAMS[k as keyof typeof AFFORDABILITY_PARAMS], String(v));
  const s = q.toString();
  return s ? `/affordability?${s}` : '/affordability';
}
