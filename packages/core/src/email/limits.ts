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
 * them in Phase 5. The per-batch cap applies to marketing sends. There is no
 * repeat window: ADR 0043 removed the 7-day same-contact rule.
 */

export type EmailLimits = {
  perAgentDay: number;
  perAgencyDay: number;
  /** Most recipients one template batch may send to (ADR 0022). */
  perBatch?: number;
  /** Pause between two messages of one batch, in ms. */
  sendDelayMs?: number;
};

export type TemplateLimits = Required<EmailLimits>;

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function emailLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): TemplateLimits {
  return {
    perAgentDay: positive(env.EMAIL_LIMIT_PER_AGENT_DAY, 50),
    perAgencyDay: positive(env.EMAIL_LIMIT_PER_AGENCY_DAY, 200),
    perBatch: positive(env.EMAIL_LIMIT_PER_BATCH, 20),
    sendDelayMs: Number.isInteger(Number(env.EMAIL_SEND_DELAY_MS)) && Number(env.EMAIL_SEND_DELAY_MS) >= 0 && env.EMAIL_SEND_DELAY_MS !== undefined && env.EMAIL_SEND_DELAY_MS !== ''
      ? Number(env.EMAIL_SEND_DELAY_MS)
      : 500,
  };
}

/**
 * Development safety (ADR 0022): outside production, template emails go ONLY
 * to addresses on `EMAIL_DEV_ALLOWLIST` — comma-separated addresses, or
 * `@domain` for a whole domain. Unset in development means NOBODY: a test
 * batch can never reach a real client by accident. In production the
 * variable is ignored.
 */
export function devAllowlist(env: NodeJS.ProcessEnv = process.env): ((email: string) => boolean) | null {
  if (env.NODE_ENV === 'production') return null;
  const entries = (env.EMAIL_DEV_ALLOWLIST ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return (email: string) => {
    const e = email.trim().toLowerCase();
    return entries.some((entry) => (entry.startsWith('@') ? e.endsWith(entry) : e === entry));
  };
}

/**
 * The one sentence every platform-composed email shows when the allowlist
 * stops it (ADR 0022, extended to every `mail_message.kind` by ADR 0025 Q6).
 */
export const DEV_ALLOWLIST_PROBLEM =
  'Not sent: this address is not on the development allowlist (EMAIL_DEV_ALLOWLIST) — nothing real is sent outside production.';

/** Null when `email` may be sent to; the reason when the dev allowlist stops it. */
export function devAllowlistProblem(email: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const allowed = devAllowlist(env);
  return allowed && !allowed(email) ? DEV_ALLOWLIST_PROBLEM : null;
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
