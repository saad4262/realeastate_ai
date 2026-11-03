import { describe, expect, it } from 'vitest';
import { estimateAffordability, interestOnlyRepayment, monthlyRepayment, principalFor, type AffordabilityInput } from './affordability';
import { affordabilityPath, readAffordability, readAmount } from './search-params';

/** The mock's scenario (docs/mocks/consumer-affordability.html #calculator): every figure there is checked here. */
const brisbane: AffordabilityInput = {
  price: 750_000,
  state: 'QLD',
  propertyKind: 'established',
  ownerOccupier: true,
  firstHome: true,
  deposit: 150_000,
  ratePct: 6.1,
  termYears: 30,
  repayment: 'pi',
  otherCosts: 2_600,
  budget: { takeHomeMonthly: 9_800, livingMonthly: 5_000, otherRepaymentsMonthly: 600 },
};

describe('the loan arithmetic', () => {
  it('principal and interest, interest only, and a zero rate', () => {
    expect(monthlyRepayment(600_000, 6.1, 30)).toBe(3_635.97);
    expect(interestOnlyRepayment(600_000, 6.1)).toBe(3_050);
    expect(monthlyRepayment(120_000, 0, 10)).toBe(1_000);
    expect(monthlyRepayment(0, 6, 30)).toBe(0);
  });

  it('principalFor undoes monthlyRepayment (to the cent the repayment was rounded to)', () => {
    expect(Math.abs(principalFor(monthlyRepayment(500_000, 7.25, 25), 7.25, 25) - 500_000)).toBeLessThan(5);
  });
});

describe('the mock’s Brisbane first home', () => {
  const a = estimateAffordability(brisbane);

  it('repayments at the rate and at +1% and +2%', () => {
    expect(a.loan).toBe(600_000);
    expect(a.monthly).toBe(3_635.97);
    expect(a.rises).toEqual([
      { ratePct: 7.1, monthly: 4_032.19 },
      { ratePct: 8.1, monthly: 4_444.49 },
    ]);
    expect(a.totalInterest).toBe(708_949);
  });

  it('cash upfront, with the first home duty', () => {
    expect(a.upfront).toEqual({ deposit: 150_000, duty: 10_925, otherCosts: 2_600, total: 163_525 });
    expect(a.lmiMayApply).toBe(false); // exactly 20%
  });

  it('what they could borrow, tested at the rate + 3%, and the dearest home it reaches after duty and costs', () => {
    expect(a.borrowing).toEqual({ surplusMonthly: 4_200, assessmentRatePct: 9.1, capacity: 517_000, covers: false, maxPrice: 660_000, maxPriceIncludesDuty: true });
    expect(a.sources.map((s) => s.url).join()).toMatch(/apra\.gov\.au/);
  });
});

describe('the edges', () => {
  it('an interest-only loan shows interest only, and the rises stay principal and interest', () => {
    const a = estimateAffordability({ ...brisbane, repayment: 'io' });
    expect(a.monthly).toBe(3_050);
    expect(a.rises[0]!.monthly).toBe(4_032.19);
  });

  it('a small deposit says LMI may apply; no budget, no borrowing answer', () => {
    const a = estimateAffordability({ ...brisbane, deposit: 100_000, budget: undefined });
    expect(a.lmiMayApply).toBe(true);
    expect(a.borrowing).toBeNull();
  });

  it('a state whose duty is not verified: no upfront total, and the dearest home leaves duty out and says so', () => {
    const a = estimateAffordability({ ...brisbane, state: 'NT', firstHome: false });
    expect(a.duty.status).toBe('unverified');
    expect(a.upfront.total).toBeNull();
    expect(a.borrowing?.maxPriceIncludesDuty).toBe(false);
  });

  it('the dearest home stops before a concession cliff it cannot afford: price plus duty fits the cash', () => {
    const a = estimateAffordability({ ...brisbane, deposit: 300_000 });
    const cash = 300_000 + a.borrowing!.capacity - 2_600;
    const at = estimateAffordability({ ...brisbane, deposit: 300_000, price: a.borrowing!.maxPrice });
    expect(a.borrowing!.maxPrice + at.upfront.duty!).toBeLessThanOrEqual(cash);
  });
});

describe('the page address', () => {
  it('reads amounts the way people type them', () => {
    expect(readAmount('$750,000')).toBe(750_000);
    expect(readAmount('750k')).toBe(750_000);
    expect(readAmount('1.2m')).toBe(1_200_000);
    expect(readAmount('abc')).toBeNull();
  });

  it('says what is missing, and keeps what was typed', () => {
    const r = readAffordability(new URLSearchParams('price=750k&state=qld'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toEqual(['your deposit', 'an interest rate']);
      expect(r.form.price).toBe('750k');
    }
  });

  it('round-trips a scenario', () => {
    const path = affordabilityPath({ price: 750_000, state: 'QLD', buyer: 'first', deposit: 150_000, rate: 6.1, costs: 2_600, pay: 9_800, living: 5_000, debts: 600 });
    const r = readAffordability(new URLSearchParams(path.split('?')[1]));
    expect(r.ok && estimateAffordability(r.input).borrowing?.maxPrice).toBe(660_000);
  });

  it('reads who is buying: a first home buyer lives there, an investor does not, and living there is the default', () => {
    const who = (buyer: string) => {
      const r = readAffordability(new URLSearchParams(`price=500000&state=NSW&deposit=50000&rate=6${buyer}`));
      return r.ok ? [r.input.firstHome, r.input.ownerOccupier] : null;
    };
    expect(who('&buyer=first')).toEqual([true, true]);
    expect(who('&buyer=investor')).toEqual([false, false]);
    expect(who('')).toEqual([false, true]);
  });
});
