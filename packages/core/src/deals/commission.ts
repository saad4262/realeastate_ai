import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { deal, dealEvent, type Db, type DbOrTx } from '@repo/db';
import { can, type Actor } from '../permissions';
import { agencyTimeZone } from '../widgets/registry';
import { instantToLocalInput } from '../time/local-input';
import { DealError } from './errors';

/**
 * Commission (ADR 0064): set by the agency on a deal, worked out by ONE SQL expression the Deal tab and the
 * Finance page both read, so they always agree. Amounts exclude GST; GST is its own line. Numbers come from
 * SQL and code, never a model (#4).
 */

export const GST_RATE = 0.1;

/**
 * The commission's amounts for a deal `d` (with its agent's profile `ap` joined): add after FROM … `d`.
 * commission: the percent of the sale price, or the fixed fee; split: this deal's, else the profile's;
 * agent's share rounded to the cent; agency's share = commission − agent's share, so they add up.
 */
export const COMMISSION_JOINS = sql`
  left join agent_profile ap on ap.user_id = d.agent_id
  cross join lateral (select case d.commission_basis
      when 'percent' then round(d.sale_price * d.commission_rate / 100, 2)
      when 'fixed' then d.commission_fixed end as amount) cm
  cross join lateral (select coalesce(d.agent_split, ap.commission_split_agent::numeric) as split) sp
  cross join lateral (select case when cm.amount is not null and sp.split is not null then round(cm.amount * sp.split / 100, 2) end as agent_share) ash`;

/** The columns COMMISSION_JOINS gives, as text (numerics keep their cents). */
export const COMMISSION_COLUMNS = sql`cm.amount::text as commission, sp.split::text as split, (d.agent_split is null) as split_from_profile,
  ash.agent_share::text as agent_share, (cm.amount - ash.agent_share)::text as agency_share, round(cm.amount * ${GST_RATE}, 2)::text as gst`;

export type CommissionAmounts = {
  commission: number | null;
  gst: number | null;
  /** The vendor's invoice: commission + GST. */
  invoice: number | null;
  split: number | null;
  splitFromProfile: boolean;
  agentShare: number | null;
  agencyShare: number | null;
};

const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

export function amountsFrom(r: { commission: string | null; split: string | null; split_from_profile: boolean; agent_share: string | null; agency_share: string | null; gst: string | null }): CommissionAmounts {
  const commission = n(r.commission);
  const gst = n(r.gst);
  return {
    commission,
    gst,
    // Cents added as integers, so the invoice is exact.
    invoice: commission !== null && gst !== null ? Math.round(commission * 100 + gst * 100) / 100 : null,
    split: n(r.split),
    splitFromProfile: Boolean(r.split_from_profile),
    agentShare: n(r.agent_share),
    agencyShare: n(r.agency_share),
  };
}

export type CommissionState = 'none' | 'expected' | 'earned' | 'paid';
export function commissionState(d: { status: string; stage: string; commission: number | null; paidOn: string | null }): CommissionState {
  if (d.commission === null) return 'none';
  if (d.paidOn) return 'paid';
  if (d.status === 'settled') return 'earned';
  if (d.status === 'open' && (d.stage === 'contract' || d.stage === 'settlement')) return 'expected';
  return 'none';
}

export const commissionSchema = z
  .object({
    basis: z.enum(['percent', 'fixed']),
    rate: z.coerce.number().min(0).max(20).nullable().optional(),
    fixed: z.coerce.number().min(0).max(100_000_000).nullable().optional(),
    /** The agent's share in percent for this deal; null = their profile's split. */
    agentSplit: z.coerce.number().min(0).max(100).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.basis === 'percent' && (v.rate === null || v.rate === undefined)) ctx.addIssue({ code: 'custom', path: ['rate'], message: 'Enter the rate' });
    if (v.basis === 'fixed' && (v.fixed === null || v.fixed === undefined)) ctx.addIssue({ code: 'custom', path: ['fixed'], message: 'Enter the fee' });
  });
export type CommissionInput = z.input<typeof commissionSchema>;

async function loadForCommission(db: DbOrTx, actor: Actor, dealId: string) {
  if (!actor.agencyId || !/^[0-9a-f-]{36}$/i.test(dealId)) throw new DealError('not_found', 'That deal was not found.');
  if (!can(actor, 'deal:commission', { type: 'deal', agencyId: actor.agencyId })) throw new DealError('forbidden', 'Only an owner or admin sets the commission.');
  const [d] = await db.select({ id: deal.id, agencyId: deal.agencyId, status: deal.status }).from(deal).where(eq(deal.id, dealId)).limit(1);
  if (!d || d.agencyId !== actor.agencyId) throw new DealError('not_found', 'That deal was not found.');
  if (d.status === 'withdrawn') throw new DealError('conflict', 'This deal was withdrawn.');
  return d;
}

/** The agency sets the commission (ADR 0064 §1). */
export async function setDealCommission(db: Db, actor: Actor, dealId: string, input: CommissionInput): Promise<void> {
  const c = commissionSchema.parse(input);
  const d = await loadForCommission(db, actor, dealId);
  await db.transaction(async (tx) => {
    await tx
      .update(deal)
      .set({
        commissionBasis: c.basis,
        commissionRate: c.basis === 'percent' ? String(c.rate) : null,
        commissionFixed: c.basis === 'fixed' ? String(c.fixed) : null,
        agentSplit: c.agentSplit === null || c.agentSplit === undefined ? null : String(c.agentSplit),
        updatedAt: sql`now()`,
      })
      .where(eq(deal.id, d.id));
    await tx.insert(dealEvent).values({
      dealId: d.id,
      agencyId: d.agencyId,
      kind: 'edited',
      actorId: actor.userId,
      note: c.basis === 'percent' ? `Commission set: ${c.rate}% of the sale price` : `Commission set: a fixed fee`,
    });
  });
}

/** The agency marks the agent's share paid (or clears it). Only once the deal has settled. */
export async function markCommissionPaid(db: Db, actor: Actor, dealId: string, paidOn: string | null): Promise<void> {
  if (paidOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new DealError('invalid', 'Use a date.');
  const d = await loadForCommission(db, actor, dealId);
  if (d.status !== 'settled') throw new DealError('conflict', 'The agent’s share is paid once the deal has settled.');
  await db.transaction(async (tx) => {
    await tx.update(deal).set({ commissionPaidOn: paidOn, updatedAt: sql`now()` }).where(eq(deal.id, d.id));
    await tx.insert(dealEvent).values({ dealId: d.id, agencyId: d.agencyId, kind: 'edited', actorId: actor.userId, note: paidOn ? `Agent’s share paid on ${paidOn}` : 'Agent’s share no longer marked paid' });
  });
}

// ── The Finance page ────────────────────────────────────────────────────────

export const FINANCE_PERIODS = ['month', 'quarter', 'fy', 'last_fy'] as const;
export type FinancePeriod = (typeof FINANCE_PERIODS)[number];

/** The period's first and last day (inclusive), as YYYY-MM-DD, from today's date on the agency's clock. Pure. */
export function periodRange(period: FinancePeriod, today: string): { from: string; to: string; label: string } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const iso = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10);
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (period === 'month') return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)), label: `${MONTHS[m - 1]} ${y}` };
  if (period === 'quarter') {
    const q0 = Math.floor((m - 1) / 3) * 3 + 1;
    return { from: iso(y, q0, 1), to: iso(y, q0 + 2, lastDay(y, q0 + 2)), label: `${MONTHS[q0 - 1]}–${MONTHS[q0 + 1]} ${y}` };
  }
  // Australia's financial year: 1 July to 30 June.
  const start = m >= 7 ? y : y - 1;
  const s = period === 'fy' ? start : start - 1;
  return { from: iso(s, 7, 1), to: iso(s + 1, 6, 30), label: `FY ${s}–${String(s + 1).slice(2)}` };
}

export type FinanceDeal = CommissionAmounts & {
  id: string;
  listingId: string | null;
  address: string;
  suburb: string;
  propertyType: string | null;
  agentId: string | null;
  agentName: string | null;
  salePrice: number | null;
  settlementDate: string | null;
  paidOn: string | null;
  /** In this period's figures as earned (settled in it), expected (under contract), and/or paid (paid in it). */
  earnedInPeriod: boolean;
  expected: boolean;
  paidInPeriod: boolean;
};

export type FinanceReport = {
  scope: 'agency' | 'mine';
  period: { key: FinancePeriod; from: string; to: string; label: string };
  deals: FinanceDeal[];
  tiles: { earned: number; earnedCount: number; expected: number; expectedCount: number; agencyEarned: number; agentEarned: number; paidOut: number; agentExpected: number };
  /** Deals under contract or settled with no commission set yet — the agency's to fill in. */
  missingCommission: number;
};

const cents = (xs: (number | null)[]) => Math.round(xs.reduce<number>((s, x) => s + Math.round((x ?? 0) * 100), 0)) / 100;

/** The Finance page (ADR 0064 §6): owners and admins see the agency; anyone else their own deals and share. */
export async function financeReport(db: DbOrTx, actor: Actor, opts: { period: FinancePeriod; now?: Date }): Promise<FinanceReport> {
  if (!actor.agencyId || !can(actor, 'listing:read', { type: 'listing', agencyId: actor.agencyId })) throw new DealError('forbidden', 'You do not have access to Finance.');
  const agencyId = actor.agencyId;
  const scope = can(actor, 'report:read_agency', { type: 'report', agencyId }) ? 'agency' : 'mine';
  const today = instantToLocalInput(opts.now ?? new Date(), await agencyTimeZone(db, agencyId)).slice(0, 10);
  const range = periodRange(opts.period, today);
  const rows = await db.execute<{
    id: string; listing_id: string | null; address: string; suburb: string; property_type: string | null; agent_id: string | null; agent_name: string | null;
    sale_price: string | null; settlement_date: string | null; paid_on: string | null; status: string; stage: string;
    commission: string | null; split: string | null; split_from_profile: boolean; agent_share: string | null; agency_share: string | null; gst: string | null;
  }>(sql`
    select d.id, d.listing_id, concat_ws(', ', nullif(trim(concat_ws(' ', p.street_number, p.street)), ''), p.suburb) as address, p.suburb, coalesce(dl.property_type, p.property_type) as property_type,
      d.agent_id, coalesce(u.name, u.email) as agent_name, d.sale_price::text, d.settlement_date::text, d.commission_paid_on::text as paid_on, d.status, d.stage::text as stage,
      ${COMMISSION_COLUMNS}
    from deal d
    join property p on p.id = d.property_id
    left join listing dl on dl.id = d.listing_id
    left join "user" u on u.id = d.agent_id
    ${COMMISSION_JOINS}
    where d.agency_id = ${agencyId}
      ${scope === 'mine' ? sql`and d.agent_id = ${actor.userId}` : sql``}
      and (
        (d.status = 'settled' and d.settlement_date between ${range.from}::date and ${range.to}::date)
        or (d.status = 'open' and d.stage in ('contract', 'settlement'))
        or (d.commission_paid_on between ${range.from}::date and ${range.to}::date)
      )
    order by d.settlement_date nulls last, d.created_at
    limit 2000`);
  const deals: FinanceDeal[] = rows.map((r) => ({
    ...amountsFrom(r),
    id: r.id,
    listingId: r.listing_id,
    address: r.address,
    suburb: r.suburb,
    propertyType: r.property_type,
    agentId: r.agent_id,
    agentName: r.agent_name,
    salePrice: n(r.sale_price),
    settlementDate: r.settlement_date,
    paidOn: r.paid_on,
    earnedInPeriod: r.status === 'settled' && r.settlement_date !== null && r.settlement_date >= range.from && r.settlement_date <= range.to,
    expected: r.status === 'open',
    paidInPeriod: r.paid_on !== null && r.paid_on >= range.from && r.paid_on <= range.to,
  }));
  const earned = deals.filter((d) => d.earnedInPeriod);
  const expected = deals.filter((d) => d.expected);
  return {
    scope,
    period: { key: opts.period, ...range },
    deals,
    tiles: {
      earned: cents(earned.map((d) => d.commission)),
      earnedCount: earned.length,
      expected: cents(expected.map((d) => d.commission)),
      expectedCount: expected.length,
      agencyEarned: cents(earned.map((d) => d.agencyShare)),
      agentEarned: cents(earned.map((d) => d.agentShare)),
      agentExpected: cents(expected.map((d) => d.agentShare)),
      paidOut: cents(deals.filter((d) => d.paidInPeriod).map((d) => d.agentShare)),
    },
    missingCommission: deals.filter((d) => (d.earnedInPeriod || d.expected) && d.commission === null).length,
  };
}

export type FinanceGroup = { key: string; label: string; settled: number; earned: number; agentShare: number; agencyShare: number; expected: number };

/** The table's rows: the report's deals summed by agent, suburb or property type. Pure. */
export function groupFinance(deals: readonly FinanceDeal[], by: 'agent' | 'suburb' | 'type'): FinanceGroup[] {
  const groups = new Map<string, { label: string; items: FinanceDeal[] }>();
  for (const d of deals) {
    const key = by === 'agent' ? d.agentId ?? '-' : by === 'suburb' ? d.suburb.toLowerCase() : (d.propertyType ?? '-').toLowerCase();
    const label = by === 'agent' ? d.agentName ?? 'No agent' : by === 'suburb' ? d.suburb : d.propertyType ? d.propertyType.charAt(0).toUpperCase() + d.propertyType.slice(1) : 'Not stated';
    const g = groups.get(key) ?? { label, items: [] };
    g.items.push(d);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => {
      const e = g.items.filter((d) => d.earnedInPeriod);
      return {
        key,
        label: g.label,
        settled: e.length,
        earned: cents(e.map((d) => d.commission)),
        agentShare: cents(e.map((d) => d.agentShare)),
        agencyShare: cents(e.map((d) => d.agencyShare)),
        expected: cents(g.items.filter((d) => d.expected).map((d) => d.commission)),
      };
    })
    .sort((a, b) => b.earned - a.earned || b.expected - a.expected || a.label.localeCompare(b.label));
}
