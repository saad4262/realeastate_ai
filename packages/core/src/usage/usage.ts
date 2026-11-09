import { and, eq } from 'drizzle-orm';
import { missedCallSetting, phoneNumber, type Db } from '@repo/db';
import { checkAssistantBudget } from '../assistant/budget';
import { checkEmailLimits, emailLimitsFromEnv } from '../email/limits';
import { can, type Actor } from '../permissions';
import { DEFAULT_TEXTS_PER_NUMBER_DAY, textsFromNumberToday } from '../phone/sms-rules';
import type { BudgetWindow } from '../schedules/budget';

/**
 * What one person has used in the last 24 hours, against the limits (ADR 0088). Asks the same functions
 * that stop a send or a model call, so what this says and what they do cannot differ. Dollars never
 * leave this file: a person sees how much of their AI allowance is gone.
 */

export type UsageMeter = { used: number; limit: number; percent: number; reached: boolean };

export type ActorUsage = {
  /** The larger of the person's and the agency's share of the assistant limits. */
  ai: { percent: number; allowed: boolean; message: string | null };
  email: { person: UsageMeter; agency: UsageMeter };
  /** Null when this person has no active number. */
  sms: UsageMeter | null;
};

/** Whole percent, rounded down, at most 100. A limit of zero is all used. */
export function percentOf(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.floor((used / limit) * 100));
}

/** `>=` as at the send: at exactly the limit, the next one is refused. */
export function meter(used: number, limit: number): UsageMeter {
  return { used, limit, percent: percentOf(used, limit), reached: used >= limit };
}

/** A window that is spent shows as 100, even when its cap is a rounding away. */
function windowPercent(w: BudgetWindow): number {
  return w.exceeded ? 100 : percentOf(w.spentUsd, w.capUsd);
}

async function smsMeter(db: Db, who: { agencyId: string; userId: string }): Promise<UsageMeter | null> {
  const [number] = await db
    .select({ id: phoneNumber.id, perNumber: missedCallSetting.textsPerNumberDay })
    .from(phoneNumber)
    .leftJoin(missedCallSetting, eq(missedCallSetting.agencyId, phoneNumber.agencyId))
    .where(and(eq(phoneNumber.agencyId, who.agencyId), eq(phoneNumber.userId, who.userId), eq(phoneNumber.status, 'active')))
    .limit(1);
  if (!number) return null;
  return meter(await textsFromNumberToday(db, number.id), number.perNumber ?? DEFAULT_TEXTS_PER_NUMBER_DAY);
}

/** Null: this person may not see it. Three statements, or four with a phone number; none per row. */
export async function usageFor(db: Db, actor: Actor, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<ActorUsage | null> {
  if (!actor.agencyId || !can(actor, 'usage:read', { type: 'usage', agencyId: actor.agencyId })) return null;
  const env = opts.env ?? process.env;
  const who = { agencyId: actor.agencyId, userId: actor.userId };
  const limits = emailLimitsFromEnv(env);
  const [budget, email, sms] = await Promise.all([checkAssistantBudget(db, actor, { env }), checkEmailLimits(db, who, limits, 0), smsMeter(db, who)]);
  return {
    ai: { percent: Math.max(windowPercent(budget.person), windowPercent(budget.agency)), allowed: budget.allowed, message: budget.message },
    email: { person: meter(email.agentUsed, limits.perAgentDay), agency: meter(email.agencyUsed, limits.perAgencyDay) },
    sms,
  };
}
