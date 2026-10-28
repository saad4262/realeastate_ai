import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { amountsFrom, COMMISSION_JOINS, commissionSchema, commissionState, groupFinance, periodRange, type FinanceDeal } from './commission';

/** ADR 0064: commission set by the agency, worked out once, summed honestly. */

describe('periods on the agency’s clock', () => {
  it('uses Australia’s financial year, July to June', () => {
    expect(periodRange('fy', '2026-10-27')).toEqual({ from: '2026-07-01', to: '2027-06-30', label: 'FY 2026–27' });
    expect(periodRange('fy', '2027-03-01')).toEqual({ from: '2026-07-01', to: '2027-06-30', label: 'FY 2026–27' });
    expect(periodRange('last_fy', '2026-10-27')).toEqual({ from: '2025-07-01', to: '2026-06-30', label: 'FY 2025–26' });
  });
  it('knows a month’s and a quarter’s last day', () => {
    expect(periodRange('month', '2028-02-10')).toMatchObject({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange('quarter', '2026-11-15')).toMatchObject({ from: '2026-10-01', to: '2026-12-31', label: 'Oct–Dec 2026' });
  });
});

describe('the one expression', () => {
  it('works the percent or the fixed fee, the split from the deal else the profile, and the agency’s share as the rest', () => {
    const q = new PgDialect().sqlToQuery(sql`${COMMISSION_JOINS}`).sql;
    expect(q).toContain("when 'percent' then round(d.sale_price * d.commission_rate / 100, 2)");
    expect(q).toContain("when 'fixed' then d.commission_fixed");
    expect(q).toContain('coalesce(d.agent_split, ap.commission_split_agent::numeric)');
    expect(q).toContain('round(cm.amount * sp.split / 100, 2)');
  });
  it('adds GST to the commission in cents for the invoice', () => {
    const a = amountsFrom({ commission: '17204.00', split: '60', split_from_profile: true, agent_share: '10322.40', agency_share: '6881.60', gst: '1720.40' });
    expect(a).toEqual({ commission: 17204, gst: 1720.4, invoice: 18924.4, split: 60, splitFromProfile: true, agentShare: 10322.4, agencyShare: 6881.6 });
    expect(amountsFrom({ commission: null, split: null, split_from_profile: true, agent_share: null, agency_share: null, gst: null }).invoice).toBeNull();
  });
});

describe('expected → earned → paid out', () => {
  it('follows the deal', () => {
    expect(commissionState({ status: 'open', stage: 'contract', commission: 100, paidOn: null })).toBe('expected');
    expect(commissionState({ status: 'open', stage: 'marketing', commission: 100, paidOn: null })).toBe('none');
    expect(commissionState({ status: 'settled', stage: 'settlement', commission: 100, paidOn: null })).toBe('earned');
    expect(commissionState({ status: 'settled', stage: 'settlement', commission: 100, paidOn: '2026-12-10' })).toBe('paid');
    expect(commissionState({ status: 'settled', stage: 'settlement', commission: null, paidOn: null })).toBe('none');
  });
});

describe('the agency’s form', () => {
  it('needs a rate for a percent and a fee for a fixed fee, and keeps them in range', () => {
    expect(commissionSchema.safeParse({ basis: 'percent' }).success).toBe(false);
    expect(commissionSchema.safeParse({ basis: 'fixed', rate: 2 }).success).toBe(false);
    expect(commissionSchema.safeParse({ basis: 'percent', rate: 25 }).success).toBe(false);
    expect(commissionSchema.safeParse({ basis: 'percent', rate: 2.2, agentSplit: 120 }).success).toBe(false);
    expect(commissionSchema.parse({ basis: 'percent', rate: '2.2', agentSplit: null })).toEqual({ basis: 'percent', rate: 2.2, agentSplit: null });
  });
});

describe('grouping', () => {
  const d = (o: Partial<FinanceDeal>): FinanceDeal => ({
    id: Math.random().toString(36), listingId: null, address: 'x', suburb: 'Pakenham', propertyType: 'house', agentId: 'a', agentName: 'Sarah',
    salePrice: 1, settlementDate: null, paidOn: null, earnedInPeriod: false, expected: false, paidInPeriod: false,
    commission: null, gst: null, invoice: null, split: null, splitFromProfile: true, agentShare: null, agencyShare: null, ...o,
  });
  it('sums earned and expected per group to the cent, and leaves deals without a commission out of the sums', () => {
    const g = groupFinance(
      [
        d({ earnedInPeriod: true, commission: 0.1, agentShare: 0.06, agencyShare: 0.04 }),
        d({ earnedInPeriod: true, commission: 0.2, agentShare: 0.12, agencyShare: 0.08 }),
        d({ expected: true, commission: 500 }),
        d({ earnedInPeriod: true, commission: null, agentId: 'b', agentName: 'Omar' }),
      ],
      'agent',
    );
    expect(g[0]).toMatchObject({ label: 'Sarah', settled: 2, earned: 0.3, agentShare: 0.18, agencyShare: 0.12, expected: 500 });
    expect(g[1]).toMatchObject({ label: 'Omar', settled: 1, earned: 0 });
  });
});
