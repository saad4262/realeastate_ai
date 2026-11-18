import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { aiCreditGrant, aiCreditHold, aiRun, type Db, type DbOrTx } from '@repo/db';

/**
 * AI credits (ADR 0092, PLATFORM-PLAN 2.3). A credit is US$0.01 of model cost. Before a model call a paid agency's
 * credits are reserved under its own advisory lock, so parallel calls cannot spend past the balance and no other
 * agency waits on that lock. The minute tick settles the real cost (`ai_run`) against the grants — the allowance
 * first, then the grant that expires soonest — and drops lapsed holds.
 */
export const CREDITS_PER_USD = 100;
export const HOLD_MS = 10 * 60_000;

/** Credits reserved per model call (AI_CREDIT_ESTIMATE, default 5 = US$0.05); the real cost settles later. */
export function creditEstimate(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AI_CREDIT_ESTIMATE?.trim());
  return Number.isInteger(n) && n > 0 ? n : 5;
}

export type GrantRow = { id: string; source: string; credits: number; used: number; expiresAt: Date };

/**
 * Pure: take `credits` from the grants — plan (allowance) grants first, then the rest, each group soonest-expiring
 * first. Returns what each grant takes and what no grant could cover (spent past the balance; shown, never hidden).
 */
export function allocate(grants: readonly GrantRow[], credits: number): { take: { id: string; add: number }[]; overdraft: number } {
  const order = [...grants].sort((a, b) => Number(b.source === 'plan') - Number(a.source === 'plan') || a.expiresAt.getTime() - b.expiresAt.getTime());
  const take: { id: string; add: number }[] = [];
  let left = credits;
  for (const g of order) {
    if (left <= 0) break;
    const room = Math.max(0, g.credits - g.used);
    const add = Math.min(room, left);
    if (add > 0) {
      take.push({ id: g.id, add });
      left -= add;
    }
  }
  return { take, overdraft: Math.max(0, left) };
}

/** What a paid agency may still spend: active grants' remainder − runs not yet settled − live holds. */
export async function creditBalance(db: DbOrTx, agencyId: string, now: Date): Promise<number> {
  const at = now.toISOString();
  const [row] = await db.execute<{ granted: string; unsettled: string; held: string }>(sql`
    select
      coalesce((select sum(g.credits - g.used) from ai_credit_grant g where g.agency_id = ${agencyId} and g.valid_from <= ${at}::timestamptz and g.expires_at > ${at}::timestamptz), 0) as granted,
      coalesce((select sum(r.cost_usd) * ${CREDITS_PER_USD} from ai_run r where r.agency_id = ${agencyId} and r.credit_settled_at is null), 0) as unsettled,
      coalesce((select sum(h.credits) from ai_credit_hold h where h.agency_id = ${agencyId} and h.expires_at > ${at}::timestamptz), 0) as held`);
  return Number(row?.granted ?? 0) - Number(row?.unsettled ?? 0) - Number(row?.held ?? 0);
}

export type Reservation = { ok: true; holdId: string } | { ok: false; balance: number };

/** Reserve under the agency's lock: refused when the estimate does not fit. Other agencies never wait on this lock. */
export async function reserveCredits(db: DbOrTx, agencyId: string, credits: number, now: Date): Promise<Reservation> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`credits:${agencyId}`}, 0))`);
    const balance = await creditBalance(tx, agencyId, now);
    if (balance < credits) return { ok: false as const, balance };
    const [hold] = await tx
      .insert(aiCreditHold)
      .values({ agencyId, credits, createdAt: now, expiresAt: new Date(now.getTime() + HOLD_MS) })
      .returning({ id: aiCreditHold.id });
    return { ok: true as const, holdId: hold!.id };
  });
}

/** A grant, once per Stripe payment (`stripeRef`). Returns false when that payment already granted. */
export async function grantCredits(
  db: DbOrTx,
  g: { agencyId: string; credits: number; source: 'plan' | 'topup' | 'admin'; validFrom: Date; expiresAt: Date; stripeRef?: string | null },
): Promise<boolean> {
  const rows = await db
    .insert(aiCreditGrant)
    .values({ agencyId: g.agencyId, credits: g.credits, source: g.source, validFrom: g.validFrom, expiresAt: g.expiresAt, stripeRef: g.stripeRef ?? null })
    .onConflictDoNothing({ target: aiCreditGrant.stripeRef })
    .returning({ id: aiCreditGrant.id });
  return rows.length > 0;
}

export type SettleReport = { agencies: number; runs: number; credits: number; overdraft: number; holdsDropped: number };

/**
 * The minute tick: settle unsettled runs, agency by agency under each one's lock. An agency with no grant at all
 * (trial, no billing) has its runs marked settled with nothing taken, so the queue never grows.
 */
export async function settleCredits(db: Db, now: Date, limitAgencies = 50): Promise<SettleReport> {
  const report: SettleReport = { agencies: 0, runs: 0, credits: 0, overdraft: 0, holdsDropped: 0 };
  const at = now.toISOString();
  const dropped = await db.delete(aiCreditHold).where(lte(aiCreditHold.expiresAt, now)).returning({ id: aiCreditHold.id });
  report.holdsDropped = dropped.length;
  const agencies = await db.execute<{ agency_id: string }>(sql`
    select distinct agency_id from ai_run where credit_settled_at is null and agency_id is not null limit ${limitAgencies}`);
  for (const { agency_id: agencyId } of agencies) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`credits:${agencyId}`}, 0))`);
      const runs = await tx.execute<{ id: string; cost: string | null }>(sql`
        select id, cost_usd as cost from ai_run where agency_id = ${agencyId} and credit_settled_at is null order by created_at limit 1000 for update skip locked`);
      if (!runs.length) return;
      const credits = runs.reduce((s, r) => s + Number(r.cost ?? 0) * CREDITS_PER_USD, 0);
      const grants = (
        await tx.execute<{ id: string; source: string; credits: number; used: string; expires_at: Date | string }>(sql`
          select id, source, credits, used, expires_at from ai_credit_grant
          where agency_id = ${agencyId} and valid_from <= ${at}::timestamptz and expires_at > ${at}::timestamptz for update`)
      ).map((g) => ({ id: g.id, source: g.source, credits: Number(g.credits), used: Number(g.used), expiresAt: new Date(g.expires_at) }));
      if (grants.length) {
        const { take, overdraft } = allocate(grants, credits);
        for (const t of take) await tx.update(aiCreditGrant).set({ used: sql`${aiCreditGrant.used} + ${t.add}` }).where(eq(aiCreditGrant.id, t.id));
        report.overdraft += overdraft;
        report.credits += credits;
      }
      await tx.update(aiRun).set({ creditSettledAt: now }).where(and(eq(aiRun.agencyId, agencyId), inArray(aiRun.id, runs.map((r) => r.id))));
      report.agencies += 1;
      report.runs += runs.length;
    });
  }
  return report;
}
