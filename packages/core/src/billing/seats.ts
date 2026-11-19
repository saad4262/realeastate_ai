import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';
import { isPaidPlan, planNumbers } from './plans';

/**
 * Seats (ADR 0092, PLATFORM-PLAN 2.10). Checked inside the transaction that makes someone an active member, with the
 * agency row locked, so two people claiming the last seat at once cannot both get it. Trial and legacy plans, and a
 * paid plan whose seats are not configured, have no limit.
 */
export class SeatLimitError extends Error {
  constructor() {
    super('Your agency has used all its seats. The owner can add a seat in Billing.');
  }
}

export async function assertSeatFree(tx: DbOrTx, agencyId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [a] = await tx.execute<{ plan: string | null }>(sql`select plan from agency where id = ${agencyId} for update`);
  if (!isPaidPlan(a?.plan)) return;
  const seats = planNumbers(a.plan, env).seats;
  if (seats === null) return;
  const [c] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from membership where agency_id = ${agencyId} and status = 'active'`);
  if (Number(c?.n ?? 0) >= seats) throw new SeatLimitError();
}
