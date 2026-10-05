import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { mailMessage, type DbOrTx } from '@repo/db';

/**
 * Daily caps on email the platform composes and sends on somebody's behalf
 * (the CRM plan's limits): an appointment invitation now, a skill's template
 * email in Phase 5. Counted from `mail_message` rows with a `kind` — so a
 * person's own reply to a buyer is never counted or blocked — that were
 * queued or sent in the last 24 hours.
 *
 * The numbers come from the environment (`EMAIL_LIMIT_PER_AGENT_DAY`,
 * `EMAIL_LIMIT_PER_AGENCY_DAY`), never from code; an admin setting replaces
 * them in Phase 5. The per-run cap and the 7-day same-contact rule apply to
 * marketing sends and arrive with them.
 */

export type EmailLimits = { perAgentDay: number; perAgencyDay: number };

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function emailLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): EmailLimits {
  return {
    perAgentDay: positive(env.EMAIL_LIMIT_PER_AGENT_DAY, 50),
    perAgencyDay: positive(env.EMAIL_LIMIT_PER_AGENCY_DAY, 200),
  };
}

export type EmailLimitCheck = {
  ok: boolean;
  agentUsed: number;
  agencyUsed: number;
  limits: EmailLimits;
  /** Why not, in a sentence for the screen. */
  reason: string | null;
};

/** Would `wanting` more templated emails from this person stay within today's limits? One statement. */
export async function checkEmailLimits(
  db: DbOrTx,
  who: { agencyId: string; userId: string },
  limits: EmailLimits,
  wanting = 1,
): Promise<EmailLimitCheck> {
  const counted = and(
    isNotNull(mailMessage.kind),
    eq(mailMessage.direction, 'out'),
    inArray(mailMessage.status, ['queued', 'sent']),
    gt(mailMessage.createdAt, sql`now() - interval '24 hours'`),
    eq(mailMessage.agencyId, who.agencyId),
  );
  const [row] = await db
    .select({
      agency: sql<string>`count(*)`,
      agent: sql<string>`count(*) filter (where ${mailMessage.sentBy} = ${who.userId})`,
    })
    .from(mailMessage)
    .where(counted);
  // bigint arrives as a string (ARCHITECTURE § 5).
  const agentUsed = Number(row?.agent ?? 0);
  const agencyUsed = Number(row?.agency ?? 0);
  const reason =
    agentUsed + wanting > limits.perAgentDay
      ? `You have sent ${agentUsed} of your ${limits.perAgentDay} emails for the last 24 hours.`
      : agencyUsed + wanting > limits.perAgencyDay
        ? `The agency has sent ${agencyUsed} of its ${limits.perAgencyDay} emails for the last 24 hours.`
        : null;
  return { ok: reason === null, agentUsed, agencyUsed, limits, reason };
}
