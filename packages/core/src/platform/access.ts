/**
 * Whether the platform has shut a person out (ADR 0050). Pure — the callers
 * already have the three facts from the row they loaded.
 *
 * - `agency_suspended`: their membership is active but a platform admin
 *   suspended the agency. Every member of it is out until it is reactivated.
 * - `member_blocked`: a platform admin blocked this one membership. Told apart
 *   from a removal (ADR 0030), which is also `suspended` but carries
 *   `removed_at` — removal is the agency's decision, blocking the platform's.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@repo/db';

export type AccessBlock = 'agency_suspended' | 'member_blocked';

/**
 * The agencies the platform has suspended, as a sub-select: `<agency id column> not in SUSPENDED_AGENCY_IDS`
 * fits any query, joined to agency or not. Public listings and the background jobs (workflows, skills,
 * scheduled actions, imports, bulk email) all skip them while it lasts.
 */
export const SUSPENDED_AGENCY_IDS = sql`(select sa.id from agency sa where sa.status = 'suspended')`;

/**
 * A billing hold (ADR 0092, PLATFORM-PLAN 2.8): past due for more than 7 days' grace, or canceled and past the end of
 * the period it paid for. Only that agency's AI and sends stop; its data stays.
 */
export const BILLING_HELD = (a: string) =>
  sql.raw(`((${a}.billing_status = 'past_due' and ${a}.past_due_since < now() - interval '7 days') or (${a}.billing_status = 'canceled' and ${a}.current_period_end < now()))`);

/**
 * Agencies whose outbound sends wait (PLATFORM-PLAN 3.7): suspended, or sends paused after a spike. For the send
 * paths only — texts, bulk email, repeating automations, AI call-backs, the job queue's send lane.
 */
export const SENDS_HELD_AGENCY_IDS = sql`(select sa.id from agency sa where sa.status = 'suspended' or sa.sends_paused_at is not null or ${BILLING_HELD('sa')})`;

export function accessBlock(row: {
  membershipStatus: string | null | undefined;
  removedAt: Date | string | null | undefined;
  agencyStatus: string | null | undefined;
}): AccessBlock | null {
  if (row.membershipStatus === 'suspended' && !row.removedAt) return 'member_blocked';
  if (row.membershipStatus === 'active' && row.agencyStatus === 'suspended') return 'agency_suspended';
  return null;
}

/** What the sign-in page says for each (`/login?error=…`). */
export const ACCESS_BLOCK_MESSAGES: Record<AccessBlock, string> = {
  agency_suspended: 'Your agency’s account is suspended. Contact the platform team to restore access.',
  member_blocked: 'Your access has been blocked by the platform team. Contact them to restore it.',
};

/** Whether this agency's outbound sends are held right now (PLATFORM-PLAN 3.7), for a send that happens at once. */
export async function sendsHeld(db: DbOrTx, agencyId: string): Promise<boolean> {
  const rows = await db.execute<{ held: boolean }>(sql`select (a.status = 'suspended' or a.sends_paused_at is not null or ${BILLING_HELD('a')}) as held from agency a where a.id = ${agencyId}`);
  return rows[0]?.held === true;
}
